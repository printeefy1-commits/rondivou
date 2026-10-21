import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reset_admin', ROOT / 'deploy/reset-admin-password.py')
reset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset)


class PasswordRecoveryTests(unittest.TestCase):
    def recover(self, path, password):
        with patch.object(reset.subprocess, 'run') as run:
            reset.reset_credentials('fixture-image', password)
        args, kwargs = run.call_args
        self.assertNotIn(password, ' '.join(args[0]))
        self.assertEqual(kwargs['input'], password)
        code = args[0][-1].replace("'/data/rondivou.sqlite'", json.dumps(str(path)))
        subprocess.run(['node', '--input-type=module', '-e', code], input=password, text=True, capture_output=True, check=True)

    def test_recovery_replaces_persistent_hash_and_revokes_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'app.sqlite'
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE admin_credentials(id INTEGER PRIMARY KEY,salt TEXT,password_hash TEXT,must_change INTEGER,updated_at TEXT); INSERT INTO admin_credentials VALUES(1,'old','old',0,'old'); CREATE TABLE sessions(id TEXT,expires_at INTEGER); INSERT INTO sessions VALUES('old-session',1); CREATE TABLE appointments(id TEXT); INSERT INTO appointments VALUES('keep');")
            password = 'fixture-recovery-private-password'
            self.recover(path, password)
            with sqlite3.connect(path) as db:
                salt, stored, required = db.execute('SELECT salt,password_hash,must_change FROM admin_credentials').fetchone()
                self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT id FROM appointments').fetchone()[0], 'keep')
            expected = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=128*1024*1024).hex()
            self.assertEqual(stored, expected)
            self.assertEqual(required, 1)
            self.assertNotIn(password.encode(), path.read_bytes())

    def test_recovery_supports_deployment_before_persistent_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'app.sqlite'
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES('old');")
            self.recover(path, 'fixture-recovery-private-password')
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
