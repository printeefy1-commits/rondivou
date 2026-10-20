#!/usr/bin/env python3
"""Read-only Meta subscription diagnostics. Prints no tokens or conversation contents."""
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request


def graph(base, path, bearer):
    request = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + bearer})
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


def main():
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
        fields = urllib.parse.urlencode({'fields': 'id,subscribed_fields'})
        page_result = graph(base, settings['META_PAGE_ID'] + '/subscribed_apps?' + fields, settings['META_PAGE_ACCESS_TOKEN'])
        callback = settings.get('PUBLIC_URL', '').rstrip('/') + '/webhooks/meta'
        report.update(summarize_subscriptions(app_result, page_result, callback, app_id))
    database = Path('/var/lib/rondivou/database/rondivou.sqlite')
    if database.is_file():
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
        try:
            report['stored_counts'] = {table: connection.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in ['conversations', 'messages']}
            report['outgoing_pending'] = [{'kind': kind, 'count': count, 'failed_count': failed} for kind, count, failed in connection.execute('SELECT kind,COUNT(*),SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) FROM outbox WHERE sent_at IS NULL GROUP BY kind')]
        finally:
            connection.close()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
