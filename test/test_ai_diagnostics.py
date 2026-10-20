import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ai_diagnostic', ROOT / 'deploy/check-ai.py')
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)


@unittest.skipUnless(shutil.which('node'), 'Node required for synthetic probe tests')
class DiagnosticTests(unittest.TestCase):
    def run_probe(self, mock):
        domain = diag.data_url((ROOT / 'src/domain.js').read_text())
        ai = (ROOT / 'src/ai.js').read_text().replace("'./domain.js'", json.dumps(domain))
        code = mock + '\n' + diag.script('PRIVATE_TEST_KEY', 'auto', diag.data_url(ai))
        result = subprocess.run(['node', '--input-type=module', '-'], input=code, text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('PRIVATE_TEST_KEY', result.stdout)
        self.assertNotIn('SENSITIVE_BODY', result.stdout)
        return json.loads(result.stdout)

    def test_auth_failure_is_identified_without_sending_inference(self):
        result = self.run_probe("globalThis.fetch = async () => new Response('SENSITIVE_BODY', {status:401});")
        self.assertEqual(result['models_http_status'], 401)
        self.assertEqual(result['result'], 'gateway_authentication_failed')
        self.assertNotIn('chat_http_status', result)

    def test_connection_failure_has_only_safe_error_code(self):
        result = self.run_probe("globalThis.fetch = async () => {throw Object.assign(new Error('PRIVATE_TEST_KEY SENSITIVE_BODY'), {cause:{code:'ENOTFOUND'}})};")
        self.assertEqual(result['models_connection'], 'ENOTFOUND')
        self.assertEqual(result['chat_connection'], 'ENOTFOUND')
        self.assertFalse(result['validation_passed'])

    def test_bad_content_is_distinguished_from_auth_and_network_errors(self):
        result = self.run_probe("globalThis.fetch = async u => new Response(JSON.stringify(u.endsWith('/models') ? {data:[{id:'model-one'}]} : {choices:[{finish_reason:'stop',message:{content:'SENSITIVE_BODY PRIVATE_TEST_KEY'}}]}));")
        self.assertEqual(result['chat_http_status'], 200)
        self.assertFalse(result['content_is_json'])
        self.assertFalse(result['validation_passed'])
        self.assertEqual(result['model_ids'], ['model-one'])

    def test_valid_synthetic_extraction_passes(self):
        answer = {'date': '2030-10-23', 'time': '10:00', 'service': 'balayage', 'client_name': '', 'phone': '', 'ambiguous': False, 'change_requested': False, 'agreement': False, 'evidence': {k: {'message_id':'connection-test','quote':'Bonjour, je voudrais un balayage le 23 octobre 2030 à 10h.'} for k in ['date','time','service']}}
        mock = "globalThis.fetch = async u => new Response(JSON.stringify(u.endsWith('/models') ? {data:[]} : {choices:[{finish_reason:'stop',message:{content:JSON.stringify(" + json.dumps(answer) + ")}}]}));"
        result = self.run_probe(mock)
        self.assertTrue(result['validation_passed'])
        self.assertTrue(result['synthetic_test_passed'])

    def test_missing_proof_is_identified_without_displaying_model_content(self):
        answer = {'date':'2030-10-23','time':'10:00','service':'balayage','client_name':'','phone':'','ambiguous':False,'change_requested':False,'agreement':False,'evidence':{}}
        mock = "globalThis.fetch = async u => new Response(JSON.stringify(u.endsWith('/models') ? {data:[]} : {choices:[{finish_reason:'stop',message:{content:JSON.stringify(" + json.dumps(answer) + ")}}]}));"
        result = self.run_probe(mock)
        self.assertFalse(result['validation_passed'])
        self.assertFalse(result['evidence_valid']['date'])


if __name__ == '__main__':
    unittest.main()
