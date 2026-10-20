#!/usr/bin/env python3
"""Update the existing AI-enabled Rondivou EC2 to one Telegram card per conversation."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

BASELINES = {
    'src/app.js': '3d1293ac6808df0c12b9fb07d8bad94cb5ea80989479ab1c1755f8d16b1ecc36',
    'src/store.js': '978fd39b90ba54013f41d5033d47a2abe4a4a490d65c1476fcfc2da92b971469',
    'src/integrations.js': '2b1f3e2ddc0100b4ff9e82837a9180482dcff0a280d832d5838ab99f7ef04f82',
    'src/telegram-cards.js': None,
}


class UpdateError(Exception):
    pass


def download(revision, relative):
    with urllib.request.urlopen('https://raw.githubusercontent.com/printeefy1-commits/rondivou/' + revision + '/' + relative, timeout=30) as response:
        return response.read(1024 * 1024)


def validate_source(relative, original, updated):
    if original == updated or (original is None and BASELINES[relative] is None):
        return
    if original is None or hashlib.sha256(original).hexdigest() != BASELINES[relative]:
        raise UpdateError('Unrecognized source or local edits: ' + relative + '. Nothing overwritten.')


def write_source(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.telegram-card-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        raise UpdateError('Inside Rondivou EC2 SSH: sudo python3 /tmp/rondivou-cards.py <commit-sha>')
    root, revision = Path('/opt/rondivou'), sys.argv[1]
    if not Path('/var/lib/rondivou/database/rondivou.sqlite').is_file():
        raise UpdateError('Expected the existing booking database. Nothing changed.')
    originals, updates = {}, {}
    for relative in BASELINES:
        target = root / relative
        if target.is_symlink():
            raise UpdateError('Refusing source symlink. Nothing changed.')
        originals[relative] = target.read_bytes() if target.exists() else None
        updates[relative] = download(revision, relative)
        validate_source(relative, originals[relative], updates[relative])
    with tempfile.TemporaryDirectory(prefix='rondivou-cards-') as temporary:
        connector_path = Path(temporary) / 'connector.py'
        connector_path.write_bytes(download(revision, 'deploy/connect-accounts.py'))
        spec = importlib.util.spec_from_file_location('connector', connector_path)
        connector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(connector)
        lines, values = connector.read_settings(root)
        if not all(values.get(key) for key in ['AI_API_KEY', 'AI_BASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID']):
            raise UpdateError('Expected the connected AI/Telegram installation. Nothing changed.')
        image = connector.deployment_image()
        original_settings = (root / 'runtime.env').read_text()
        updated_settings = connector.merge_settings(lines, {'TELEGRAM_COMPACT': 'true'})
        for content in updates.values():
            result = subprocess.run(['docker', 'exec', '-i', 'rondivou', 'node', '--input-type=module', '--check'], input=content, capture_output=True)
            if result.returncode:
                raise UpdateError('Source syntax check failed. Nothing changed.')
        backup = Path(tempfile.mkdtemp(prefix='.before-telegram-cards-', dir=root))
        for relative, original in originals.items():
            if original is not None:
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(original)
        try:
            for relative, content in updates.items():
                write_source(root / relative, content)
            connector.apply_settings(root, original_settings, updated_settings, image)
        except BaseException:
            for relative, original in originals.items():
                if original is None:
                    (root / relative).unlink(missing_ok=True)
                else:
                    write_source(root / relative, original)
            connector.docker('restart', 'rondivou')
            raise
    print('Telegram conversation cards enabled. Application health passed.')
    print('New messages, profile names and AI results update ONE card per conversation, grouped over about 8 seconds.')
    print('Cards show the last three text previews; the full conversation stays on the website.')
    print('Booking confirmations, reminders and actionable conflicts remain separate alerts.')
    print('Previously delivered Telegram messages are not deleted. The first new message creates the new card.')
    print('Passwords, keys, appointments and Meta/Telegram/AI connections are preserved. No key entry is required.')


if __name__ == '__main__':
    try:
        main()
    except UpdateError as error:
        print('Update stopped: ' + str(error))
        raise SystemExit(1)
    except KeyboardInterrupt:
        print('\nCancelled. Preserve existing containers and database if interrupted during restart.')
        raise SystemExit(130)
    except Exception:
        print('Update stopped. If the app is unhealthy, preserve the database and containers for inspection. Raw errors withheld to protect secrets.')
        raise SystemExit(1)
