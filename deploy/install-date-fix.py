#!/usr/bin/env python3
"""Install a French written-date extraction fix on the original EC2 app, preserving config and data."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

BASELINE_SHA256 = '96b3780c5678c2d1be2eba7533c45542c5c64da5c1765f9c6470c566fc7f539e'


def validate_update(original, updated):
    if b"const writtenDate = new RegExp" not in updated:
        raise RuntimeError('The selected revision does not contain written-date extraction support.')
    if original == updated:
        return False
    if hashlib.sha256(original).hexdigest() != BASELINE_SHA256:
        raise RuntimeError('Unexpected application version or local edits. Nothing replaced; preserve the existing code.')
    return True


def atomic_source(path, content, mode):
    descriptor, temporary = tempfile.mkstemp(prefix='.date-fix-', suffix='.mjs', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Docker operation failed: ' + args[0] + '. Configuration and database were not changed.')
    return result.stdout.strip()


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        raise SystemExit('Usage inside EC2 SSH: sudo python3 install-date-fix.py <commit-sha>')
    source = Path('/opt/rondivou/src/domain.js')
    if not source.is_file() or source.is_symlink():
        raise SystemExit('Expected existing deployment. Nothing changed.')
    url = 'https://raw.githubusercontent.com/printeefy1-commits/rondivou/' + sys.argv[1] + '/src/domain.js'
    with urllib.request.urlopen(url, timeout=30) as response:
        updated = response.read(1024 * 1024)
    original = source.read_bytes()
    if not validate_update(original, updated):
        print('This audit version is already installed. No restart needed.'); return
    backup = source.parent / '.domain.js.before-date-fix'
    if backup.is_symlink() or (backup.exists() and backup.read_bytes() != original):
        raise SystemExit('A different backup already exists. Nothing changed.')
    candidate = source.parent / '.domain-date-fix-check.mjs'
    if candidate.exists() or candidate.is_symlink():
        raise SystemExit('An existing audit check file needs inspection. Nothing changed.')
    atomic_source(candidate, updated, 0o644)
    try:
        docker('exec', 'rondivou', 'node', '--check', '/app/src/' + candidate.name)
    finally:
        candidate.unlink(missing_ok=True)
    if not backup.exists():
        atomic_source(backup, original, 0o600)
    atomic_source(source, updated, 0o644)
    try:
        docker('restart', 'rondivou')
        for attempt in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=3) as response:
                    if response.status == 200:
                        break
            except Exception:
                if attempt == 29:
                    raise RuntimeError('Health check failed.')
                time.sleep(1)
    except BaseException:
        atomic_source(source, original, 0o644)
        docker('restart', 'rondivou')
        print('Previous source restored. Preserve configuration and database; report the failure.')
        raise
    print('French written-date extraction fix installed. Application restarted and local health passed.')
    print('No message content, identities, signatures or tokens are logged. Password and bookings unchanged.')
    print('Open a conversation to see extracted written dates. Multiple services still require review.')


if __name__ == '__main__':
    main()
