#!/usr/bin/env python3
"""Install the readable workspace, dated conversations, account labels and Telegram cards."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

BASELINES = {
    'src/server.js': {'f29906879111d140f177274964ddd5958529849d2e52c86154612b780b3a63e4', 'e7481965c2f18d934e812ed8bebf7e5f229263d227748610d3116e598bfadcfb'},
    'src/app.js': {'a479e97206463263974709c076aefb0303b9a97f660de16ef9b6d8eda1957294', '3d1293ac6808df0c12b9fb07d8bad94cb5ea80989479ab1c1755f8d16b1ecc36', '0a3f92c91a7487def49618f654e704fcb667858850eb068ebfe479a6b6583688'},
    'src/store.js': {'eda3468c56d06b8b5ad2b7fe0c71082318e946d37be378a22b94d623acd436ec', '3e184ccd1977b5e284134af63c379989573db5efcb5cd63ab70aa8363a2099f3', '62209e3ee512ec065b045784e7ec1a442cd093d1c092a7868feec69905eeba32', '978fd39b90ba54013f41d5033d47a2abe4a4a490d65c1476fcfc2da92b971469'},
    'src/integrations.js': {'cb09e8019afe97ec0fe23c70fe4f5f4ba5bdf828f8cd40d5ab048e37d79bd1d7', 'f4525461640d0b033ad3b56656ccd94e3ab76277acc5d49b23e325a49be39280', '2b1f3e2ddc0100b4ff9e82837a9180482dcff0a280d832d5838ab99f7ef04f82'},
    'src/telegram-cards.js': set(),
    'src/style-lab.js': {'687109a292ae551a6b665861caf31b27e77f64faa15d18cfd7facb745e0809b1'},
    'public/app.js': {'6d66d22a9f8b1a13561be3c77d8120391fc306e5cfa050b359f2bd4ddd6c2761', 'f1e0ea4243f49739d28b5472310e49b912eba37d09f7bd07dec29e1cec587924', '3e90fd92aca52367c19279f3c58f6d4cd154543ebae1c2643d07e681c689f0b9', '214eed8c3d7d3c0a23369eddc4fa6673e0fa72eb0097ce872dc740b40bff1734', '33906c0f7d62fbb07d8a4307ce8e5abb035bedcba34ae9297795b4392240836a'},
    'public/style.css': {'36bf059b9ea69353e80f9b6a6bf63914c3caa686e9017b7ae7f7a65c823bd6a2', 'b3ded020c779a2a42e21c46d90a02ab343707544cab4238809733318d42cfe18', 'b4c78aed5e2e77211b42ffc65f6904d3ce360c5e370c3fedc868f326ab60b62a'},
    'public/index.html': {'28a344256c02a50588c69344a92b9eccbe61ff7bc2e7cd761949c84ac5a49bb3', '6bbdeda57d8dcf43a751764ca30f76d4e2cceaeb128ef50526ec488dba72c5bc', '1ef5cdee8591fcd5ac24874594206beab05cd2a5ab59c02e8936f39cfce3fe4b'},
}


class UpdateError(Exception):
    pass


def download(revision, relative):
    with urllib.request.urlopen('https://raw.githubusercontent.com/printeefy1-commits/rondivou/' + revision + '/' + relative, timeout=30) as response:
        return response.read(1024 * 1024)


def validate_source(relative, original, updated):
    if original == updated or (original is None and relative in ['src/telegram-cards.js','src/style-lab.js']):
        return
    if original is None or hashlib.sha256(original).hexdigest() not in BASELINES[relative]:
        raise UpdateError('Unrecognized source or local edits: ' + relative + '. Nothing overwritten.')


def write_source(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix='.workspace-update-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]):
        raise UpdateError('Inside Rondivou EC2 SSH: sudo python3 /tmp/rondivou-workspace.py <commit-sha>')
    root, revision = Path('/opt/rondivou'), sys.argv[1]
    if not Path('/var/lib/rondivou/database/rondivou.sqlite').is_file():
        raise UpdateError('Expected the existing booking database. Nothing changed.')
    originals, updates = {}, {}
    for relative in BASELINES:
        target = root / relative
        if target.is_symlink():
            raise UpdateError('Refusing source symlink. Nothing changed.')
        originals[relative] = target.read_bytes() if target.exists() else None
        updates[relative] = download(revision, relative)
        validate_source(relative, originals[relative], updates[relative])
    with tempfile.TemporaryDirectory(prefix='rondivou-workspace-') as temporary:
        connector_path = Path(temporary) / 'connector.py'
        connector_path.write_bytes(download(revision, 'deploy/connect-accounts.py'))
        spec = importlib.util.spec_from_file_location('connector', connector_path)
        connector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(connector)
        lines, values = connector.read_settings(root)
        if not all(values.get(key) for key in ['AI_API_KEY', 'AI_BASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID']):
            raise UpdateError('Expected the connected AI/Telegram installation. Nothing changed.')
        image = connector.deployment_image()
        original_settings = (root / 'runtime.env').read_text()
        updated_settings = connector.merge_settings(lines, {'TELEGRAM_COMPACT': 'true'})
        for relative, content in updates.items():
            if not relative.endswith('.js'):
                continue
            result = subprocess.run(['docker', 'exec', '-i', 'rondivou', 'node', '--input-type=module', '--check'], input=content, capture_output=True)
            if result.returncode:
                raise UpdateError('Source syntax check failed. Nothing changed.')
        backup = Path(tempfile.mkdtemp(prefix='.before-workspace-', dir=root))
        for relative, original in originals.items():
            if original is not None:
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(original)
        try:
            for relative, content in updates.items():
                write_source(root / relative, content)
            connector.apply_settings(root, original_settings, updated_settings, image)
        except BaseException:
            for relative, original in originals.items():
                if original is None:
                    (root / relative).unlink(missing_ok=True)
                else:
                    write_source(root / relative, original)
            connector.docker('restart', 'rondivou')
            raise
    print('Private Style AI Lab installed. Application health passed.')
    print('Open Laboratoire IA > Analyser les messages importes. Start new learning with this button; an existing analysis continues from its saved progress.')
    print('Unclear batches are skipped automatically. Connection failures retry automatically without skipping texts.')
    print('No customer replies are sent; sandbox tests and feedback remain private. Old prices are not used.')
    print('Unresolved account names are queued for recovery before slow AI work; empty profiles retry instead of being marked complete.')
    print('Meta may still deny profile access for some accounts. No username is guessed or invented.')
    print('Conversations show the earliest available message date and latest messages at the bottom; most recently active conversations first.')
    print('Larger text, higher contrast and mobile layouts enabled. Calendar keeps FB:/IG: account labels.')
    print('New messages, profile names and AI results update ONE card per conversation, grouped over about 8 seconds.')
    print('Cards show the last three text previews; the full conversation stays on the website.')
    print('Booking confirmations, reminders and actionable conflicts remain separate alerts.')
    print('Previously delivered Telegram messages are not deleted. The first new message creates the new card.')
    print('Passwords, keys, appointments and Meta/Telegram/AI connections are preserved. No key entry is required.')
    print('Refresh the website with Ctrl+F5 to load the updated interface.')


if __name__ == '__main__':
    try:
        main()
    except UpdateError as error:
        print('Update stopped: ' + str(error))
        raise SystemExit(1)
    except KeyboardInterrupt:
        print('\nCancelled. Preserve existing containers and database if interrupted during restart.')
        raise SystemExit(130)
    except Exception:
        print('Update stopped. If the app is unhealthy, preserve the database and containers for inspection. Raw errors withheld to protect secrets.')
        raise SystemExit(1)
