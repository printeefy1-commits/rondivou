#!/usr/bin/env bash
# Run inside the existing EC2 SSH terminal, not CloudShell. Creates no AWS resources.
set -euo pipefail
umask 077
[[ "$EUID" == 0 ]] || { echo 'Run with sudo bash.'; exit 1; }
EXPECTED_INSTANCE="${1:-}"
REV="${2:-}"
[[ "$EXPECTED_INSTANCE" =~ ^i-[a-f0-9]{8,17}$ && "$REV" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'Usage: sudo bash install-existing-ec2.sh <expected-instance-id> <source-commit-sha>'; exit 1;
}
# No AWS keys, console cookies, or IAM role are needed for installation.
TOKEN="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 -X PUT \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
INSTANCE_ID="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 \
  -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
[[ "$INSTANCE_ID" == "$EXPECTED_INSTANCE" ]] || { echo "Wrong server: $INSTANCE_ID. Expected $EXPECTED_INSTANCE. Nothing installed."; unset TOKEN; exit 1; }
IP="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 \
  -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)"
unset TOKEN
python3 - "$IP" <<'PY'
import ipaddress,sys
assert isinstance(ipaddress.ip_address(sys.argv[1]),ipaddress.IPv4Address), 'Expected a public IPv4 address'
PY
. /etc/os-release
[[ "$ID" == amzn && "$VERSION_ID" == 2023 && "$(uname -m)" == x86_64 ]] || {
  echo 'This installer supports Amazon Linux 2023 x86_64 only. Nothing installed.'; exit 1;
}
for path in /opt/rondivou /var/lib/rondivou; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Existing path $path. Stopped to preserve existing files; do not delete it blindly."; exit 1; }
done
if command -v docker >/dev/null; then
  for name in rondivou rondivou-https; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      echo "Container $name already exists. Stopped to preserve it."; exit 1
    fi
  done
fi
PORTS="$(ss -H -ltn '( sport = :80 or sport = :443 or sport = :3000 )')"
[[ -z "$PORTS" ]] || { echo 'Port 80, 443 or 3000 is occupied. Nothing installed; inspect the existing service first.'; exit 1; }
python3 - <<'PY'
import shutil
if shutil.disk_usage('/').free < 2*1024**3: raise SystemExit('At least 2 GiB free disk space required. Nothing installed.')
PY
WORK="$(mktemp -d)"
trap 'code=$?; rm -rf "$WORK"; if [[ $code != 0 && -d /opt/rondivou ]]; then echo "Installation interrupted; preserve /opt/rondivou and report the error. Do not rerun or erase files blindly."; fi' EXIT
SOURCE_URL="https://codeload.github.com/printeefy1-commits/rondivou/tar.gz/$REV"
PUBLIC_URL="https://${IP}.sslip.io"
curl --fail --silent --show-error --location --max-time 120 "$SOURCE_URL" -o "$WORK/source.tgz"
SOURCE_SHA256="$(sha256sum "$WORK/source.tgz" | cut -d ' ' -f 1)"
python3 - "$WORK/source.tgz" "$WORK/bootstrap.sh" <<'PY'
import tarfile,pathlib,sys
with tarfile.open(sys.argv[1],'r:gz') as archive:
 matches=[m for m in archive.getmembers() if m.name.endswith('/deploy/ec2-bootstrap.sh') and m.isfile()]
 if len(matches)!=1: raise SystemExit('Expected one EC2 bootstrap in the pinned source archive.')
 pathlib.Path(sys.argv[2]).write_bytes(archive.extractfile(matches[0]).read())
PY
echo "Installing on verified existing instance $INSTANCE_ID. No new instance, disk or IP is created."
export SOURCE_URL SOURCE_SHA256 PUBLIC_URL
bash "$WORK/bootstrap.sh"
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health > "$WORK/health.json"
python3 - "$WORK/health.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1])).get('status')=='ok', 'Application is not healthy'
PY
echo
echo 'Application installed; local health check passed.'
echo 'In EC2 > this instance > Security > Security group > Inbound rules:'
echo 'Allow HTTP TCP 80 and HTTPS TCP 443 from 0.0.0.0/0. Keep SSH restricted.'
echo 'HTTPS certificate issuance needs those ports reachable from the Internet.'
printf 'Website address: %s\n' "$PUBLIC_URL"
echo 'Read your login password privately with: sudo cat /opt/rondivou/admin-password'
echo 'Do not paste the password into chat. Configure Meta and Telegram separately.'
echo 'This installation uses the current public IP, without allocating an Elastic IP. If stop/start changes it, update the URL and HTTPS configuration.'
