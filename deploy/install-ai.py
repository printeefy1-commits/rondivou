#!/usr/bin/env python3
"""Install and privately configure FreeLLMAPI on the existing Rondivou EC2."""
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

# Only known released sources may be replaced; local modifications are preserved.
BASELINES = {
    'src/app.js': {'6210cda1115da9b6b8abdb6c6aca302968d5c044c8bc960db8c3dfbc4fe4d1e6', '0fc2536f2aa5419b29ef49ac302702abf4ceb172c88865248147a7d21d8c0ac6'},
    'src/domain.js': {'96b3780c5678c2d1be2eba7533c45542c5c64da5c1765f9c6470c566fc7f539e', 'c02acc5c90cc879769d6b98afc7c35aaebbac3c81583e3553f51509f4216286e'},
    'src/integrations.js': {'d7cb01486ebc2eeef061e323b980e7b6e453d67fc17a5c9536466c0fd57565cd'},
    'src/store.js': {'595d88dbaf0d95efc6530e3fc68e06ec4187d4823f737f410d97430d0750d3c5'},
    'public/app.js': {'6dec88d998218415ccc3c6c043ebd581cc369c0306f5aa934632b6965ef3a89a'},
    'src/ai.js': set(),
}
DEFAULT_URL = 'https://ip-172-31-45-34.tail8fc7b2.ts.net/v1'


class InstallError(Exception):
    pass


def download(revision, relative):
    url = 'https://raw.githubusercontent.com/printeefy1-commits/rondivou/' + revision + '/' + relative
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read(1024 * 1024)


def validate_source(relative, original, updated):
    if original == updated:
        return
    if original is None and relative == 'src/ai.js':
        return
    if original is None or hashlib.sha256(original).hexdigest() not in BASELINES[relative]:
        raise InstallError('Unexpected version or local edits in ' + relative + '. Nothing overwritten.')


def write_source(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.ai-update-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def check_ai(key, url, model):
    # Synthetic text only. Key travels through stdin, never CLI arguments or logs.
    settings = json.dumps({'AI_API_KEY': key, 'AI_BASE_URL': url, 'AI_MODEL': model}, ensure_ascii=True)
    script = "import { analyze } from '/app/src/ai.js';\nconst config = " + settings + ";\n"
    script += "try { const result = await analyze([{id:'connection-test',direction:'in',sent_at:'2030-10-20T08:00:00Z',text:'Bonjour, je voudrais un balayage le 23 octobre 2030 à 10h.'}],config); if(result.date!=='2030-10-23'||result.time!=='10:00'||result.service!=='balayage'||result.agreement||!result.complete) process.exit(2); } catch { process.exit(1); }\n"
    result = subprocess.run(['docker', 'exec', '-i', 'rondivou', 'node', '--input-type=module', '-'], input=script, text=True, capture_output=True, timeout=80)
    if result.returncode:
        raise InstallError('AI test failed: check the unified gateway key, available model and Tailscale connection. No key or model response was printed. Previous source restored.')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        raise InstallError('Inside Rondivou EC2 SSH: sudo python3 /tmp/rondivou-ai.py <commit-sha>')
    revision = sys.argv[1]
    root = Path('/opt/rondivou')
    if not Path('/var/lib/rondivou/database/rondivou.sqlite').is_file():
        raise InstallError('Existing database not found. Nothing changed.')
    originals, updates = {}, {}
    for relative in BASELINES:
        target = root / relative
        if target.is_symlink():
            raise InstallError('Refusing source symlink. Nothing changed.')
        originals[relative] = target.read_bytes() if target.exists() else None
        updates[relative] = download(revision, relative)
        validate_source(relative, originals[relative], updates[relative])
    with tempfile.TemporaryDirectory(prefix='rondivou-ai-') as temporary:
        connector_path = Path(temporary) / 'connector.py'
        connector_path.write_bytes(download(revision, 'deploy/connect-accounts.py'))
        spec = importlib.util.spec_from_file_location('connector', connector_path)
        connector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(connector)
        lines, values = connector.read_settings(root)
        image = connector.deployment_image()
        url = input('FreeLLMAPI Base URL [Enter for your Tailscale URL]: ').strip() or DEFAULT_URL
        if not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?/v1/?', url):
            raise InstallError('Use an HTTPS base URL ending in /v1 without a key, query or credentials.')
        model = input('Model [Enter for auto]: ').strip() or 'auto'
        if not re.fullmatch(r'[a-zA-Z0-9_./:-]{1,150}', model):
            raise InstallError('Invalid model name.')
        print('Use the UNIFIED API KEY from FreeLLMAPI > Keys, not an upstream provider key.')
        print('Conversation text will be sent to your gateway and its configured model providers for extraction.')
        key = getpass.getpass('FreeLLMAPI unified key (hidden, never paste in chat): ').strip()
        if not key or any(c.isspace() for c in key):
            raise InstallError('Invalid key. Nothing changed.')
        changes = {'AI_BASE_URL': url.rstrip('/'), 'AI_API_KEY': key, 'AI_MODEL': model}
        updated_settings = connector.merge_settings(lines, changes)
        original_settings = (root / 'runtime.env').read_text()
        backup = Path(tempfile.mkdtemp(prefix='.before-ai-', dir=root))
        for relative, original in originals.items():
            if original is not None:
                path = backup / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(original)
        # Check syntax inside the SAME Node image before modifying running sources.
        for relative, content in updates.items():
            check = subprocess.run(['docker', 'exec', '-i', 'rondivou', 'node', '--input-type=module', '--check'], input=content, capture_output=True)
            if check.returncode:
                raise InstallError('Source syntax validation failed. Nothing changed.')
        try:
            for relative, content in updates.items():
                write_source(root / relative, content)
            print('Testing a synthetic appointment through the gateway from the app container...')
            check_ai(key, url, model)
            connector.apply_settings(root, original_settings, updated_settings, image)
        except BaseException:
            for relative, original in originals.items():
                if original is None:
                    (root / relative).unlink(missing_ok=True)
                else:
                    write_source(root / relative, original)
            # apply_settings already restores the old container/env if it failed.
            # Restart after file restoration so it loads the previous modules.
            connector.docker('restart', 'rondivou')
            raise
    print('AI extraction installed. Synthetic extraction test and application health passed.')
    print('Existing Meta/Telegram settings, password and appointments preserved; only an additive AI table is created.')
    print('Send a NEW test conversation. Old messages are not auto-booked by this installation.')
    print('AI output is saved to the conversation form. Complete, mutually agreed and available appointments are booked automatically.')
    print('Ambiguous, historical, conflicting or incomplete requests need review. Meta profile access is still required for account names.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nCancelled. Do not share secrets in chat.')
        raise SystemExit(130)
    except InstallError as error:
        print('AI setup stopped: ' + str(error))
        raise SystemExit(1)
    except Exception:
        # Network/SDK exceptions can contain URLs. Never print raw exceptions.
        print('AI setup stopped. Check the private key, Base URL, model availability and existing deployment version. If the application is unhealthy, preserve the database and containers for inspection. Do not share secrets in chat.')
        raise SystemExit(1)
