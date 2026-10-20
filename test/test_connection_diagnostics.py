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


if __name__ == '__main__':
    unittest.main()
