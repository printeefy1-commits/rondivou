#!/usr/bin/env python3
"""Rotate the deployed EC2 admin password without printing credentials or deleting bookings."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.request


def private_write(path, text):
    descriptor, temporary = tempfile.mkstemp(prefix='.password-reset-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def rotate_files(directory):
    env_file = directory / 'runtime.env'
    password_file = directory / 'admin-password'
    if env_file.is_symlink() or password_file.is_symlink():
        raise RuntimeError('Refusing credential-file symlinks.')
    lines = env_file.read_text().splitlines()
    if not any(line.startswith('ADMIN_PASSWORD=') for line in lines):
        raise RuntimeError('ADMIN_PASSWORD is absent; inspect the deployment configuration first.')
    password = secrets.token_hex(24)
    updated = [line for line in lines if not line.startswith('ADMIN_PASSWORD=')]
    updated.append('ADMIN_PASSWORD=' + password)
    private_write(env_file, '\n'.join(updated) + '\n')
    private_write(password_file, password + '\n')
    return password


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout.strip()


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo python3.')
    directory = Path('/opt/rondivou')
    database = Path('/var/lib/rondivou/database/rondivou.sqlite')
    if not database.is_file() or not (directory / 'runtime.env').is_file():
        raise SystemExit('Expected existing EC2 deployment and database. Nothing changed.')
    mounts = json.loads(docker('inspect', '--format', '{{json .Mounts}}', 'rondivou'))
    expected = {'/app': '/opt/rondivou', '/data': '/var/lib/rondivou/database'}
    if any(not any(m['Destination'] == target and m['Source'] == source and m['Type'] == 'bind' for m in mounts) for target, source in expected.items()):
        raise SystemExit('Unexpected deployment mounts. Nothing changed.')
    image = docker('inspect', '--format', '{{.Image}}', 'rondivou')
    profile = docker('inspect', '--format', '{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.Config.WorkingDir}}', 'rondivou')
    if profile != 'host|1000:1000|/app':
        raise SystemExit('Unexpected deployment profile. Nothing changed.')
    backup = 'rondivou-before-password-reset'
    if subprocess.run(['docker', 'container', 'inspect', backup], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise SystemExit('A previous reset needs inspection. Nothing changed.')
    docker('stop', 'rondivou')
    docker('rename', 'rondivou', backup)
    try:
        password = rotate_files(directory)
        docker('run', '--rm', '--user', '1000:1000', '--mount', 'type=bind,source=/var/lib/rondivou/database,target=/data', image,
               'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/rondivou.sqlite'); db.exec('DELETE FROM sessions'); db.close();")
        docker('run', '-d', '--name', 'rondivou', '--restart', 'unless-stopped', '--network', 'host', '--user', '1000:1000',
               '--env-file', '/opt/rondivou/runtime.env', '--workdir', '/app',
               '--mount', 'type=bind,source=/opt/rondivou,target=/app,readonly',
               '--mount', 'type=bind,source=/var/lib/rondivou/database,target=/data',
               '--read-only', '--tmpfs', '/tmp', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', image, 'node', 'src/server.js')
        for attempt in range(30):
            try:
                request = urllib.request.Request('http://127.0.0.1:3000/api/login',
                    data=json.dumps({'password': password}).encode(), headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=3) as response:
                    if response.status != 200:
                        raise RuntimeError('New login not accepted.')
                break
            except Exception:
                if attempt == 29:
                    raise RuntimeError('New login could not be verified. Preserve files and report this error.')
                time.sleep(1)
        docker('rm', backup)
    except Exception:
        print('Reset interrupted. Bookings are preserved. Do not erase the database or start the old container; report this error.')
        raise
    print('Password rotated and login verified. Previous sessions revoked; bookings preserved.')
    print('Read the new password privately: sudo cat /opt/rondivou/admin-password')
    print('Do not paste the password into chat.')


if __name__ == '__main__':
    main()
