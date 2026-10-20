#!/usr/bin/env python3
"""Meta diagnostics; optional explicit Messenger or Instagram subscription setup. No tokens are printed."""
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request


def summarize_profile_error(error):
    # Application messages can be arbitrary in older versions. Never echo them.
    match = re.search(r'\((\d{3}), code (\d+)\)', error or '')
    if match:
        return {'http_status': int(match[1]), 'meta_code': int(match[2])}
    return {'reason': 'name_not_returned' if (error or '').startswith('Meta ne fournit pas encore de nom') else 'request_failed'}


def graph(base, path, bearer, payload=None):
    headers = {'Authorization': 'Bearer ' + bearer}
    if payload is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    request = urllib.request.Request(base + path, headers=headers,
                                    data=None if payload is None else urllib.parse.urlencode(payload).encode())
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        details = {'http_status': error.code}
        try:
            problem = json.load(error).get('error', {})
            for key in ['code', 'error_subcode']:
                if isinstance(problem.get(key), int):
                    details[key] = problem[key]
        except (ValueError, AttributeError):
            pass
        return {'diagnostic_error': details}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return {'diagnostic_error': 'Connection or response failure; no credentials logged.'}


def field_names(fields):
    return sorted({field if isinstance(field, str) else field.get('name', '') for field in fields})


def summarize_subscriptions(app_result, page_result, expected_callback, app_id):
    if app_result.get('diagnostic_error'):
        app_summary = app_result
    else:
        app_summary = [{'object': item.get('object'), 'active': item.get('active'),
                        'callback_matches': item.get('callback_url') == expected_callback,
                        'fields': field_names(item.get('fields', []))} for item in app_result.get('data', [])]
    if page_result.get('diagnostic_error'):
        page_summary = page_result
    else:
        matched = [item for item in page_result.get('data', []) if str(item.get('id')) == app_id]
        page_summary = {'our_app_subscribed': bool(matched),
                        'fields': sorted({field for item in matched for field in field_names(item.get('subscribed_fields', []))})}
    return {'application_webhooks': app_summary, 'facebook_page_subscription': page_summary}


def repair_app_subscription(settings, base, app_result, object_name, required):
    """Add required events to one object, preserving its events and other objects."""
    if app_result.get('diagnostic_error') or not isinstance(app_result.get('data'), list):
        return {'status': 'blocked', 'reason': 'Could not read existing subscriptions. No update attempted.'}, app_result
    callback = settings.get('PUBLIC_URL', '').rstrip('/') + '/webhooks/meta'
    if not callback.startswith('https://') or not settings.get('META_VERIFY_TOKEN'):
        return {'status': 'blocked', 'reason': 'HTTPS callback or verification token missing. No update attempted.'}, app_result
    pages = [item for item in app_result['data'] if item.get('object') == object_name]
    if len(pages) > 1 or any(item.get('callback_url') != callback for item in pages):
        return {'status': 'blocked', 'reason': 'Existing callback differs or is ambiguous. No update attempted.'}, app_result
    current = set(field_names(pages[0].get('fields', []))) if pages else set()
    if required <= current and pages[0].get('active'):
        return {'status': 'already_configured'}, app_result
    fields = sorted(current | required)
    if not all(re.fullmatch(r'[a-z][a-z0-9_]*', field) for field in fields):
        return {'status': 'blocked', 'reason': 'Unexpected existing event name. No update attempted.'}, app_result
    app_id = settings['META_APP_ID']
    bearer = app_id + '|' + settings['META_APP_SECRET']
    result = graph(base, app_id + '/subscriptions', bearer, {
        'object': object_name, 'callback_url': callback, 'verify_token': settings['META_VERIFY_TOKEN'],
        'fields': ','.join(fields)})
    if result.get('success') is not True:
        return {'status': 'update_failed', 'details': result.get('diagnostic_error', 'No success acknowledgment.')}, app_result
    updated = graph(base, app_id + '/subscriptions', bearer)
    verified = any(item.get('object') == object_name and item.get('active') and item.get('callback_url') == callback
                   and required <= set(field_names(item.get('fields', []))) for item in updated.get('data', []))
    return {'status': 'updated_and_verified' if verified else 'update_accepted_check_subscription_again'}, updated


def repair_messenger(settings, base, app_result):
    return repair_app_subscription(settings, base, app_result, 'page', {'messages', 'message_echoes'})


def repair_instagram(settings, base, app_result):
    instagram_id = settings.get('META_INSTAGRAM_ID', '')
    if not instagram_id.isdigit():
        return {'status': 'blocked', 'reason': 'Numeric linked Instagram ID missing. Nothing changed.'}, app_result
    token = settings['META_PAGE_ACCESS_TOKEN']
    page = graph(base, settings['META_PAGE_ID'] + '?' + urllib.parse.urlencode({'fields': 'instagram_business_account'}), token)
    if page.get('diagnostic_error') or str((page.get('instagram_business_account') or {}).get('id')) != instagram_id:
        return {'status': 'blocked', 'reason': 'Could not verify that this Instagram account belongs to the configured Page. Nothing changed.',
                'details': page.get('diagnostic_error')}, app_result
    # Facebook Login delivers messaging via the linked Page subscription.
    # /IG_ID/subscribed_apps is the separate Instagram Login route, not this connector.
    path = settings['META_PAGE_ID'] + '/subscribed_apps'
    query = '?' + urllib.parse.urlencode({'fields': 'id,subscribed_fields'})
    account_result = graph(base, path + query, token)
    if account_result.get('diagnostic_error') or not isinstance(account_result.get('data'), list):
        return {'status': 'blocked', 'reason': 'Could not read linked Page subscriptions. Nothing changed.',
                'details': account_result.get('diagnostic_error')}, app_result
    app_id = settings['META_APP_ID']
    matched = [item for item in account_result['data'] if str(item.get('id')) == app_id]
    if len(matched) > 1:
        return {'status': 'blocked', 'reason': 'Ambiguous linked Page subscriptions. Nothing changed.'}, app_result
    application, app_result = repair_app_subscription(settings, base, app_result, 'instagram', {'messages'})
    report = {'application': application}
    if application['status'] not in ['updated_and_verified', 'already_configured']:
        report['linked_page'] = {'status': 'not_changed', 'reason': 'Application subscription must be verified first.'}
        return report, app_result
    if matched and 'subscribed_fields' not in matched[0]:
        report['linked_page'] = {'status': 'app_present_fields_not_exposed', 'reason': 'Existing Page subscription preserved. Confirm delivery with a real test message.'}
        return report, app_result
    current = set(field_names(matched[0].get('subscribed_fields', []))) if matched else set()
    required_account = {'messages', 'message_echoes'}
    if required_account <= current:
        report['linked_page'] = {'status': 'already_configured'}
        return report, app_result
    fields = sorted(current | required_account)
    if not all(re.fullmatch(r'[a-z][a-z0-9_]*', field) for field in fields):
        report['linked_page'] = {'status': 'blocked', 'reason': 'Unknown Page event format; existing subscription preserved.'}
        return report, app_result
    response = graph(base, path, token, {'subscribed_fields': ','.join(fields)})
    if response.get('success') is not True:
        report['linked_page'] = {'status': 'update_failed', 'details': response.get('diagnostic_error', 'No success acknowledgment.')}
        return report, app_result
    verified = graph(base, path + query, token)
    own = [item for item in verified.get('data', []) if str(item.get('id')) == app_id]
    if own and required_account <= set(field_names(own[0].get('subscribed_fields', []))):
        status = 'updated_and_verified'
    elif own:
        status = 'update_accepted_app_present_check_fields'
    else:
        status = 'update_accepted_check_page_again'
    report['linked_page'] = {'status': status}
    return report, app_result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--repair-messenger', action='store_true', help='Add messages and message_echoes to this app Page webhook, preserving existing events.')
    actions.add_argument('--repair-instagram', action='store_true', help='Enable the Instagram app webhook and verify messaging via its linked Facebook Page, preserving Messenger.')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo python3 inside EC2 SSH.')
    settings = {}
    for line in Path('/opt/rondivou/runtime.env').read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            settings[key] = value
    names = ['META_APP_ID', 'META_APP_SECRET', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'META_VERIFY_TOKEN',
             'META_INSTAGRAM_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID', 'TELEGRAM_WEBHOOK_SECRET']
    report = {'saved_settings_present': {key: bool(settings.get(key)) for key in names}}
    code = 'console.log(JSON.stringify(Object.fromEntries(' + json.dumps(names) + '.map(k=>[k,Boolean(process.env[k])]))))'
    container = subprocess.run(['docker', 'exec', 'rondivou', 'node', '-e', code], capture_output=True, text=True)
    try:
        report['running_settings_present'] = json.loads(container.stdout) if container.returncode == 0 else 'Container unavailable'
    except ValueError:
        report['running_settings_present'] = 'Could not read presence status'
    version = settings.get('META_GRAPH_VERSION', 'v23.0')
    if not re.fullmatch(r'v\d+\.\d+', version):
        raise SystemExit('Invalid Graph API version; no request sent.')
    if all(settings.get(key) for key in ['META_APP_ID', 'META_APP_SECRET', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN']):
        base = 'https://graph.facebook.com/' + version + '/'
        app_id = settings['META_APP_ID']
        if not app_id.isdigit() or not settings['META_PAGE_ID'].isdigit():
            raise SystemExit('Invalid numeric identifiers; no request sent.')
        app_result = graph(base, app_id + '/subscriptions', app_id + '|' + settings['META_APP_SECRET'])
        if args.repair_messenger:
            report['messenger_repair'], app_result = repair_messenger(settings, base, app_result)
        if args.repair_instagram:
            report['instagram_repair'], app_result = repair_instagram(settings, base, app_result)
        fields = urllib.parse.urlencode({'fields': 'id,subscribed_fields'})
        page_result = graph(base, settings['META_PAGE_ID'] + '/subscribed_apps?' + fields, settings['META_PAGE_ACCESS_TOKEN'])
        callback = settings.get('PUBLIC_URL', '').rstrip('/') + '/webhooks/meta'
        report.update(summarize_subscriptions(app_result, page_result, callback, app_id))
    database = Path('/var/lib/rondivou/database/rondivou.sqlite')
    if database.is_file():
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
        try:
            report['stored_counts'] = {table: connection.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in ['conversations', 'messages']}
            report['unresolved_profile_counts'] = [{'channel': channel, 'count': count} for channel, count in connection.execute('SELECT channel,COUNT(*) FROM conversations WHERE username=external_id GROUP BY channel')]
            report['profile_lookup_errors'] = [{**summarize_profile_error(error), 'count': count} for error, count in connection.execute("SELECT error,COUNT(*) FROM outbox WHERE kind='meta_profile' AND sent_at IS NULL AND error IS NOT NULL GROUP BY error")]
            report['outgoing_pending'] = [{'kind': kind, 'count': count, 'failed_count': failed} for kind, count, failed in connection.execute('SELECT kind,COUNT(*),SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) FROM outbox WHERE sent_at IS NULL GROUP BY kind')]
        finally:
            connection.close()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
