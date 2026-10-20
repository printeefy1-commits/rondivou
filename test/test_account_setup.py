"""Setup helper checks; run: python3 -m unittest discover -s test -p 'test_*.py'."""
import contextlib
import importlib.util
import io
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('account_setup', Path(__file__).parents[1] / 'deploy/connect-accounts.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_merge_retains_password_and_other_credentials_without_duplicate_changed_keys(self):
        original = ['ADMIN_PASSWORD=fixture-password', 'META_PAGE_ACCESS_TOKEN=fixture-page-token', 'TELEGRAM_ADMIN_ID=1', 'TELEGRAM_ADMIN_ID=2']
        text = setup.merge_settings(original, {'TELEGRAM_ADMIN_ID': '50'})
        self.assertIn('ADMIN_PASSWORD=fixture-password', text)
        self.assertIn('META_PAGE_ACCESS_TOKEN=fixture-page-token', text)
        self.assertEqual(text.count('TELEGRAM_ADMIN_ID='), 1)
        with self.assertRaises(setup.SetupError):
            setup.merge_settings(original, {'TELEGRAM_ADMIN_ID': '50\nADMIN_PASSWORD=injected'})

    def test_private_write_is_private_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'runtime.env'
            setup.private_write(path, 'private-fixture')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            link = Path(td) / 'link'
            link.symlink_to(path)
            with self.assertRaises(setup.SetupError):
                setup.private_write(link, 'changed')
            self.assertEqual(path.read_text(), 'private-fixture')

    def test_enrollment_requires_matching_nonce_and_same_user_in_private_chat(self):
        token = '123456:' + 'fixture' * 5
        def fake_api(received, method, payload=None):
            self.assertEqual(received, token)
            if method == 'getMe':
                return {'username': 'FixtureSalonBot'}
            if method == 'getWebhookInfo':
                return {'url': ''}
            return [
                {'update_id': 1, 'message': {'text': '/start wrong', 'chat': {'id': 1, 'type': 'private'}, 'from': {'id': 1}}},
                {'update_id': 2, 'message': {'text': '/start enrollment', 'chat': {'id': -1, 'type': 'group'}, 'from': {'id': 2}}},
                {'update_id': 3, 'message': {'text': '/start enrollment', 'chat': {'id': 3, 'type': 'private'}, 'from': {'id': 4}}},
                {'update_id': 4, 'message': {'text': '/start enrollment', 'chat': {'id': 50, 'type': 'private'}, 'from': {'id': 50}}},
            ]
        output = io.StringIO()
        with patch.object(setup.getpass, 'getpass', return_value=token), patch.object(setup.secrets, 'token_urlsafe', return_value='enrollment'), patch.object(setup, 'telegram', side_effect=fake_api), contextlib.redirect_stdout(output):
            settings = setup.collect_telegram({})
        self.assertEqual(settings['TELEGRAM_ADMIN_ID'], '50')
        self.assertNotIn(token, output.getvalue())

    def test_existing_webhook_is_not_deleted_or_replaced(self):
        with patch.object(setup.getpass, 'getpass', return_value='123:' + 'fixture' * 5), patch.object(setup, 'telegram', side_effect=[{'username': 'FixtureBot'}, {'url': 'https://another-app.example/hook'}]) as api, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(setup.SetupError):
                setup.collect_telegram({})
        self.assertEqual([call.args[1] for call in api.call_args_list], ['getMe', 'getWebhookInfo'])

    def test_remote_errors_do_not_expose_token_in_url(self):
        sensitive_url = 'https://api.telegram.org/botfixture-secret/getMe'
        error = urllib.error.HTTPError(sensitive_url, 401, 'Unauthorized', None, None)
        with patch.object(setup.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(setup.SetupError) as caught:
                setup.api(sensitive_url)
        self.assertNotIn('fixture-secret', str(caught.exception))
        self.assertIn('401', str(caught.exception))

    def test_meta_rejects_token_from_another_application(self):
        with patch('builtins.input', side_effect=['123', '456']), patch.object(setup, 'secret_input', return_value='fixture-value'), patch.object(setup, 'api', return_value={'data': {'is_valid': True, 'app_id': '999'}}), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(setup.SetupError):
                setup.collect_meta({})

    def test_failed_reload_restores_configuration_and_old_container(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            original = 'ADMIN_PASSWORD=fixture-password\nPUBLIC_URL=https://example.test\n'
            (directory / 'runtime.env').write_text(original)
            booking = directory / 'booking-fixture'
            booking.write_bytes(b'unchanged')
            completed = subprocess.CompletedProcess([], 1)
            with patch.object(setup, 'docker', return_value='') as docker, patch.object(setup.subprocess, 'run', return_value=completed), patch.object(setup, 'api', side_effect=setup.SetupError('offline')), patch.object(setup.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(setup.SetupError):
                    setup.apply_settings(directory, original, original + 'TELEGRAM_ADMIN_ID=50\n', 'fixture-image')
            self.assertEqual((directory / 'runtime.env').read_text(), original)
            self.assertEqual(booking.read_bytes(), b'unchanged')
            docker.assert_any_call('rename', 'rondivou-before-connection-change', 'rondivou')
            docker.assert_any_call('start', 'rondivou')


if __name__ == '__main__':
    unittest.main()
