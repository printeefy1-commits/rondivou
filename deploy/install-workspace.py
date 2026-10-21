#!/usr/bin/env python3
"""Update appointment workspace, calendar phone numbers and persistent admin credentials."""
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
    'src/server.js': {'bf53a0c45e6e5cec2f2fa244d6e01b11db66cd882e20f3d3492417c631df7c71', 'e7481965c2f18d934e812ed8bebf7e5f229263d227748610d3116e598bfadcfb', 'f29906879111d140f177274964ddd5958529849d2e52c86154612b780b3a63e4'},
    'src/app.js': {'0ba5c6427971c6306ebf529c0bbc23f3d8926501c728fa585f5d80a240a5690f', '0a3f92c91a7487def49618f654e704fcb667858850eb068ebfe479a6b6583688', '3d1293ac6808df0c12b9fb07d8bad94cb5ea80989479ab1c1755f8d16b1ecc36', '92224159f87f1968ae1db18cc6e3a4ecab78b92f4689d0f1cd600a190d724add', 'a479e97206463263974709c076aefb0303b9a97f660de16ef9b6d8eda1957294'},
    'src/store.js': {'2bd657141cc7ce9d5ddf5ff658fa1b433b2274d2427c088a31964e0f90e605f3', '3e184ccd1977b5e284134af63c379989573db5efcb5cd63ab70aa8363a2099f3', '62209e3ee512ec065b045784e7ec1a442cd093d1c092a7868feec69905eeba32', '978fd39b90ba54013f41d5033d47a2abe4a4a490d65c1476fcfc2da92b971469', 'eda3468c56d06b8b5ad2b7fe0c71082318e946d37be378a22b94d623acd436ec'},
    'src/integrations.js': {'2b1f3e2ddc0100b4ff9e82837a9180482dcff0a280d832d5838ab99f7ef04f82', 'cb09e8019afe97ec0fe23c70fe4f5f4ba5bdf828f8cd40d5ab048e37d79bd1d7', 'f4525461640d0b033ad3b56656ccd94e3ab76277acc5d49b23e325a49be39280'},
    'src/telegram-cards.js': set(),
    'src/passwords.js': set(),
    'public/app.js': {'8e6a42fc91763aa7a548f2cf5f361b44537f7bae06b7158b01486b560d18c645', '78e4a8e97a3f3acd94f0d0a52e4b775af4005e18c45f8ef7c9a4014d81a6123a', '64cba80ab9e8ba9d9146ab99f40bbb4b820de9493da71ab486fc34be14abf824', '046fe39a61d07c8d94f3ef62eb670d2e6aa331752d1588cff372577d1e44fbed', '214eed8c3d7d3c0a23369eddc4fa6673e0fa72eb0097ce872dc740b40bff1734', '33906c0f7d62fbb07d8a4307ce8e5abb035bedcba34ae9297795b4392240836a', '3e90fd92aca52367c19279f3c58f6d4cd154543ebae1c2643d07e681c689f0b9', '6d66d22a9f8b1a13561be3c77d8120391fc306e5cfa050b359f2bd4ddd6c2761', 'f1e0ea4243f49739d28b5472310e49b912eba37d09f7bd07dec29e1cec587924'},
    'public/style.css': {'26e675d9ead10209bd8f0eb1b9148bd75e8d2008954035e0594ceddac5833f45', '36bf059b9ea69353e80f9b6a6bf63914c3caa686e9017b7ae7f7a65c823bd6a2', '6c679fa1d5ae357b84f8262d12548880997fe8f286bbb37f8b7b00a962db2ef5', 'b3ded020c779a2a42e21c46d90a02ab343707544cab4238809733318d42cfe18', 'b4c78aed5e2e77211b42ffc65f6904d3ce360c5e370c3fedc868f326ab60b62a'},
    'public/index.html': {'cb0304663a6600d0e37cd00e6f51e71e2deb3723b5418aa2e7c5ee932b6c57b9', '1ef5cdee8591fcd5ac24874594206beab05cd2a5ab59c02e8936f39cfce3fe4b', '28a344256c02a50588c69344a92b9eccbe61ff7bc2e7cd761949c84ac5a49bb3', '5417a97b674389cc2965d6af8f4691b1deefb702ede50376540f2bbf9113848a', '6bbdeda57d8dcf43a751764ca30f76d4e2cceaeb128ef50526ec488dba72c5bc'},
}


class UpdateError(Exception):
    pass


def download(revision, relative):
    with urllib.request.urlopen('https://raw.githubusercontent.com/printeefy1-commits/rondivou/' + revision + '/' + relative, timeout=30) as response:
        return response.read(1024 * 1024)


def validate_source(relative, original, updated):
    if original == updated or (original is None and relative in ['src/telegram-cards.js','src/passwords.js']):
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
        updated_settings = connector.merge_settings(lines, {'TELEGRAM_COMPACT': 'true', 'REQUIRE_PASSWORD_CHANGE': 'true'})
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
    print('Appointment workspace updated. Application health passed.')
    print('AI laboratory and style learning disabled. Appointment extraction and existing connections preserved.')
    print('Conversations can be searched by account name or any saved message, including imported history. Click a result to open the matching message.')
    print('Calendar cards now show the saved phone number alongside FB:/IG: account labels.')
    print('On first access after this update, sign in with your current password and choose a different one (16 characters minimum).')
    print('The chosen password is stored as a salted hash in the persistent database and survives later updates and restarts.')
    print('After changing it, the old admin-password file is no longer your website login. No key entry is required.')
    print('Appointments, messages and Meta/Telegram/AI settings preserved. Existing Telegram conversation cards continue normally.')
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
