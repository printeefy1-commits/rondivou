import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ai_installer', Path(__file__).resolve().parents[1] / 'deploy/install-ai.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class AIInstallerTests(unittest.TestCase):
    def test_local_edits_refused_and_same_version_allowed(self):
        with self.assertRaises(installer.InstallError):
            installer.validate_source('src/store.js', b'custom code', b'new code')
        installer.validate_source('src/store.js', b'new code', b'new code')
        installer.validate_source('src/ai.js', None, b'new code')
        with self.assertRaises(installer.InstallError):
            installer.validate_source('src/store.js', None, b'new code')

    def test_atomic_source_is_readable_by_container_user(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'app.js'
            installer.write_source(target, b'new code')
            self.assertEqual(target.read_bytes(), b'new code')
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)

    def test_synthetic_probe_sends_secret_only_through_stdin(self):
        with patch.object(installer.subprocess, 'run') as run:
            run.return_value.returncode = 0
            installer.check_ai('private-key', installer.DEFAULT_URL, 'auto')
            args, kwargs = run.call_args
            self.assertNotIn('private-key', ' '.join(args[0]))
            self.assertIn('private-key', kwargs['input'])
            self.assertNotIn('scope-id', kwargs['input'])
            self.assertTrue(kwargs['capture_output'])

    def test_probe_does_not_expose_raw_provider_errors(self):
        with patch.object(installer.subprocess, 'run') as run:
            run.return_value.returncode = 1
            run.return_value.stderr = 'SENSITIVE OUTPUT'
            with self.assertRaises(installer.InstallError) as error:
                installer.check_ai('private-key', installer.DEFAULT_URL, 'auto')
            self.assertNotIn('private-key', str(error.exception))
            self.assertNotIn('SENSITIVE', str(error.exception))


if __name__ == '__main__':
    unittest.main()
