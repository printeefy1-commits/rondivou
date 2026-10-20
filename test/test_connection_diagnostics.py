"""Verify diagnostics redact secrets and inspect the correct subscription, without Meta requests."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error
import io

spec = importlib.util.spec_from_file_location('diagnostics', Path(__file__).parents[1] / 'deploy/check-connections.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


class DiagnosticTests(unittest.TestCase):
    def settings(self):
        return {'PUBLIC_URL': 'https://example.test', 'META_APP_ID': '123', 'META_APP_SECRET': 'fixture-app-secret', 'META_VERIFY_TOKEN': 'fixture-verify-secret'}

    def test_both_subscription_layers_and_callback_are_reported_without_private_fields(self):
        app = {'data': [{'object': 'page', 'active': True, 'callback_url': 'https://example.test/webhooks/meta', 'verify_token': 'fixture-secret', 'fields': [{'name': 'messages'}, {'name': 'message_echoes'}]}]}
        page = {'data': [{'id': '123', 'subscribed_fields': ['messages', 'message_echoes'], 'access_token': 'fixture-secret'}, {'id': '456', 'subscribed_fields': ['feed']} ]}
        result = diagnostics.summarize_subscriptions(app, page, 'https://example.test/webhooks/meta', '123')
        self.assertTrue(result['application_webhooks'][0]['callback_matches'])
        self.assertEqual(result['facebook_page_subscription']['fields'], ['message_echoes', 'messages'])
        self.assertNotIn('fixture-secret', str(result))

    def test_missing_subscription_does_not_claim_success(self):
        result = diagnostics.summarize_subscriptions({'data': []}, {'data': [{'id': 'other'}]}, 'https://example.test/webhooks/meta', '123')
        self.assertEqual(result['application_webhooks'], [])
        self.assertFalse(result['facebook_page_subscription']['our_app_subscribed'])

    def test_http_error_does_not_print_tokens_or_server_messages(self):
        error = urllib.error.HTTPError('https://example.test/fixture-secret', 400, 'bad', None,
                                      io.BytesIO(b'{"error":{"message":"fixture-secret","code":190,"error_subcode":463}}'))
        with patch.object(diagnostics.urllib.request, 'urlopen', side_effect=error):
            result = diagnostics.graph('https://example.test/', 'subscriptions', 'fixture-secret')
        self.assertEqual(result['diagnostic_error']['code'], 190)
        self.assertNotIn('fixture-secret', str(result))

    def test_repair_preserves_page_events_and_other_object_subscriptions(self):
        original = {'data': [
            {'object': 'page', 'active': True, 'callback_url': 'https://example.test/webhooks/meta', 'fields': [{'name': 'feed'}]},
            {'object': 'instagram', 'active': True, 'callback_url': 'https://example.test/webhooks/meta', 'fields': [{'name': 'messages'}]}]}
        updated = {'data': [{'object': 'page', 'active': True, 'callback_url': 'https://example.test/webhooks/meta', 'fields': [{'name': 'feed'}, {'name': 'messages'}, {'name': 'message_echoes'}]}]}
        with patch.object(diagnostics, 'graph', side_effect=[{'success': True}, updated]) as api:
            result, _ = diagnostics.repair_messenger(self.settings(), 'https://graph.example/v23.0/', original)
        self.assertEqual(result['status'], 'updated_and_verified')
        payload = api.call_args_list[0].args[3]
        self.assertEqual(payload['object'], 'page')
        self.assertEqual(payload['fields'], 'feed,message_echoes,messages')
        self.assertNotIn('fixture-app-secret', str(result))
        self.assertNotIn('fixture-verify-secret', str(result))

    def test_repair_refuses_callback_change_or_unreadable_state(self):
        cases = [{'diagnostic_error': 'not authorized'}, {'data': [{'object': 'page', 'callback_url': 'https://different-app.test/webhook'}]}]
        for original in cases:
            with patch.object(diagnostics, 'graph') as api:
                result, _ = diagnostics.repair_messenger(self.settings(), 'https://graph.example/', original)
            self.assertEqual(result['status'], 'blocked')
            api.assert_not_called()

    def test_no_write_when_events_are_already_configured(self):
        original = {'data': [{'object': 'page', 'active': True, 'callback_url': 'https://example.test/webhooks/meta', 'fields': ['messages', 'message_echoes']}]}
        with patch.object(diagnostics, 'graph') as api:
            result, _ = diagnostics.repair_messenger(self.settings(), 'https://graph.example/', original)
        self.assertEqual(result['status'], 'already_configured')
        api.assert_not_called()

    def test_failed_update_or_missing_verification_is_not_reported_as_success(self):
        original = {'data': [{'object': 'page', 'active': True, 'callback_url': 'https://example.test/webhooks/meta', 'fields': []}]}
        with patch.object(diagnostics, 'graph', return_value={'diagnostic_error': {'http_status': 403}}):
            result, _ = diagnostics.repair_messenger(self.settings(), 'https://graph.example/', original)
        self.assertEqual(result['status'], 'update_failed')
        with patch.object(diagnostics, 'graph', side_effect=[{'success': True}, original]):
            result, _ = diagnostics.repair_messenger(self.settings(), 'https://graph.example/', original)
        self.assertEqual(result['status'], 'update_accepted_check_subscription_again')


if __name__ == '__main__':
    unittest.main()
