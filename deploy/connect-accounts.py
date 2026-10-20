#!/usr/bin/env python3
"""Configure accounts privately in the deployed EC2 SSH terminal. Never logs tokens."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class SetupError(Exception):
    pass


def api(url, payload=None, bearer=None):
    headers = {'Content-Type': 'application/json'}
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    request = urllib.request.Request(url, headers=headers, data=None if payload is None else json.dumps(payload).encode())
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        # Never include the URL (Telegram tokens are in its path), headers or raw response.
        raise SetupError('Service rejected the request (HTTP %s). Check the token and permissions.' % error.code) from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise SetupError('Service connection failed. Check network access and try again; no token was logged.') from None
    if data.get('ok') is False or data.get('error'):
        raise SetupError('Service rejected the request. Check the token and permissions.')
    return data


def telegram(token, method, payload=None):
    data = api('https://api.telegram.org/bot' + token + '/' + method, payload)
    return data['result']


def read_settings(directory):
    path = directory / 'runtime.env'
    if not path.is_file() or path.is_symlink():
        raise SetupError('Expected a private runtime.env in the existing deployment.')
    lines = path.read_text().splitlines()
    values = {}
    for line in lines:
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key] = value
    return lines, values


def merge_settings(lines, changes):
    for key, value in changes.items():
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or any(c in value for c in '\r\n\x00'):
            raise SetupError('Invalid configuration field.')
    return '\n'.join([line for line in lines if line.partition('=')[0] not in changes] + [key + '=' + value for key, value in changes.items()]) + '\n'


def private_write(path, text):
    if path.is_symlink():
        raise SetupError('Refusing a configuration-file symlink.')
    descriptor, temporary = tempfile.mkstemp(prefix='.account-setup-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True)
    if result.returncode:
        raise SetupError('Docker operation failed: %s. Inspect container status without dumping its environment.' % args[0])
    return result.stdout.strip()


def deployment_image():
    mounts = json.loads(docker('inspect', '--format', '{{json .Mounts}}', 'rondivou'))
    for target, source in {'/app': '/opt/rondivou', '/data': '/var/lib/rondivou/database'}.items():
        if not any(m['Destination'] == target and m['Source'] == source and m['Type'] == 'bind' for m in mounts):
            raise SetupError('Unexpected deployment mounts. Nothing changed.')
    profile = docker('inspect', '--format', '{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.Config.WorkingDir}}', 'rondivou')
    if profile != 'host|1000:1000|/app':
        raise SetupError('Unexpected deployment profile. Nothing changed.')
    return docker('inspect', '--format', '{{.Image}}', 'rondivou')


def apply_settings(directory, original, updated, image):
    backup = 'rondivou-before-connection-change'
    if subprocess.run(['docker', 'container', 'inspect', backup], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise SetupError('A previous connection change needs inspection. Nothing changed.')
    docker('stop', 'rondivou')
    try:
        docker('rename', 'rondivou', backup)
    except SetupError:
        docker('start', 'rondivou')
        raise
    try:
        private_write(directory / 'runtime.env', updated)
        docker('run', '-d', '--name', 'rondivou', '--restart', 'unless-stopped', '--network', 'host', '--user', '1000:1000',
               '--env-file', '/opt/rondivou/runtime.env', '--workdir', '/app',
               '--mount', 'type=bind,source=/opt/rondivou,target=/app,readonly',
               '--mount', 'type=bind,source=/var/lib/rondivou/database,target=/data',
               '--read-only', '--tmpfs', '/tmp', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', image, 'node', 'src/server.js')
        for attempt in range(30):
            try:
                if api('http://127.0.0.1:3000/health').get('status') == 'ok':
                    break
            except SetupError:
                pass
            if attempt == 29:
                raise SetupError('Application health check failed.')
            time.sleep(1)
    except BaseException:
        try:
            # A failed docker run can leave a created/stopped container too.
            subprocess.run(['docker', 'rm', '-f', 'rondivou'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            private_write(directory / 'runtime.env', original)
            docker('rename', backup, 'rondivou')
            docker('start', 'rondivou')
            print('Previous application configuration restored. Bookings were not changed.')
        except Exception:
            print('Rollback needs inspection. Preserve the database and both containers; do not reinstall.')
        raise
    docker('rm', backup)


def collect_telegram(values):
    print('Use a bot dedicated to Rondivou, created through the verified @BotFather account.')
    token = getpass.getpass('Paste BotFather token here (hidden, never in chat): ').strip()
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]{20,}', token):
        raise SetupError('Token format is invalid. Nothing changed.')
    bot = telegram(token, 'getMe')
    webhook = telegram(token, 'getWebhookInfo')
    if webhook.get('url'):
        raise SetupError('This bot already has a webhook. Nothing changed; keep the existing bot connection and ask how to migrate it.')
    nonce = secrets.token_urlsafe(18)
    print('Open @%s in Telegram with the ONE account allowed to manage the salon.' % bot['username'])
    print('Send this command to that bot: /start %s' % nonce)
    print('Waiting for your private message (up to five minutes)...')
    deadline = time.monotonic() + 300
    offset = None
    while time.monotonic() < deadline:
        payload = {'timeout': 10, 'allowed_updates': ['message']}
        if offset is not None:
            payload['offset'] = offset
        updates = telegram(token, 'getUpdates', payload)
        for update in updates:
            offset = max(offset or 0, update['update_id'] + 1)
            message = update.get('message', {})
            if message.get('text', '').strip() != '/start ' + nonce:
                continue
            chat, sender = message.get('chat', {}), message.get('from', {})
            if chat.get('type') != 'private' or chat.get('id') != sender.get('id') or sender.get('is_bot'):
                continue
            admin = str(sender['id'])
            if not re.fullmatch(r'\d+', admin):
                continue
            print('Private Telegram account verified: %s. Only this account will be authorized.' % admin)
            return {'TELEGRAM_BOT_TOKEN': token, 'TELEGRAM_ADMIN_ID': admin,
                    'TELEGRAM_WEBHOOK_SECRET': values.get('TELEGRAM_WEBHOOK_SECRET') or secrets.token_urlsafe(32)}
    raise SetupError('No matching private /start received. Nothing changed; retry when ready.')


def secret_input(label):
    value = getpass.getpass(label + ' (hidden): ').strip()
    if len(value) < 16 or any(c.isspace() for c in value):
        raise SetupError('Invalid secret format. Nothing changed.')
    return value


def collect_meta(values):
    print('This connector uses Instagram professional account linked to a Facebook Page (Facebook Login route).')
    app_id = input('Meta App ID: ').strip()
    page_id = input('Facebook Page ID: ').strip()
    if not app_id.isdigit() or not page_id.isdigit():
        raise SetupError('App ID and Page ID must be numeric. Nothing changed.')
    app_secret = secret_input('Meta App Secret')
    page_token = secret_input('Page Access Token from this app')
    version = values.get('META_GRAPH_VERSION') or 'v23.0'
    if not re.fullmatch(r'v\d+\.\d+', version):
        raise SetupError('Invalid Graph API version.')
    base = 'https://graph.facebook.com/' + version + '/'
    token_info = api(base + 'debug_token?' + urllib.parse.urlencode({'input_token': page_token}), bearer=app_id + '|' + app_secret).get('data', {})
    if not token_info.get('is_valid') or str(token_info.get('app_id')) != app_id:
        raise SetupError('Token is invalid or belongs to another Meta app. Nothing changed.')
    if token_info.get('expires_at') and token_info['expires_at'] < time.time():
        raise SetupError('Token has expired. Nothing changed.')
    page = api(base + page_id + '?' + urllib.parse.urlencode({'fields': 'id,name,instagram_business_account{id,username}'}), bearer=page_token)
    instagram = page.get('instagram_business_account') or {}
    if str(page.get('id')) != page_id or not instagram.get('id'):
        raise SetupError('Page not accessible or no linked Instagram professional account. Nothing changed.')
    required = {'pages_messaging', 'pages_manage_metadata', 'instagram_basic', 'instagram_manage_messages'}
    missing = sorted(required - set(token_info.get('scopes', [])))
    if missing:
        raise SetupError('Required token permissions are missing: ' + ', '.join(missing) + '. Nothing changed.')
    print('Page verified: %s; Instagram: %s. Live message delivery still needs webhook tests.' % (page.get('name', page_id), instagram.get('username', instagram['id'])))
    return {'META_APP_ID': app_id, 'META_APP_SECRET': app_secret, 'META_PAGE_ACCESS_TOKEN': page_token,
            'META_PAGE_ID': page_id, 'META_INSTAGRAM_ID': str(instagram['id']), 'META_GRAPH_VERSION': version,
            'META_VERIFY_TOKEN': values.get('META_VERIFY_TOKEN') or secrets.token_urlsafe(32)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('account', choices=['telegram', 'meta'])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SetupError('Run with sudo python3 inside the EC2 SSH terminal.')
    directory = Path('/opt/rondivou')
    if not Path('/var/lib/rondivou/database/rondivou.sqlite').is_file():
        raise SetupError('Expected the existing booking database. Nothing changed.')
    lines, values = read_settings(directory)
    if not values.get('PUBLIC_URL', '').startswith('https://'):
        raise SetupError('Configure the HTTPS PUBLIC_URL first.')
    image = deployment_image()
    changes = collect_telegram(values) if args.account == 'telegram' else collect_meta(values)
    updated = merge_settings(lines, changes)
    original = (directory / 'runtime.env').read_text()
    apply_settings(directory, original, updated, image)
    if args.account == 'meta':
        private_write(directory / 'meta-verify-token', changes['META_VERIFY_TOKEN'] + '\n')
        print('Meta credentials saved. Set the callback URL to ' + values['PUBLIC_URL'].rstrip('/') + '/webhooks/meta')
        print('Read the verification token privately: sudo cat /opt/rondivou/meta-verify-token')
        print('Complete Messenger and Instagram webhook subscriptions in Meta, then run real channel tests.')
    else:
        print('Telegram settings saved. Open the website > Connexions > Connecter et tester Telegram.')
        print('Then send /start to your bot again to verify replies and webhook reception.')
    print('Application restarted and healthy. Password, bookings and other settings preserved. Do not share tokens in chat.')


if __name__ == '__main__':
    try:
        main()
    except SetupError as error:
        print('Setup stopped: ' + str(error))
        raise SystemExit(1)
    except KeyboardInterrupt:
        print('\nSetup cancelled. Do not paste secrets or terminal transcripts containing them into chat.')
        raise SystemExit(130)
