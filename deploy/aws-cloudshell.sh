#!/usr/bin/env bash
# Run inside your own AWS CloudShell, after uploading and extracting the source archive.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
command -v aws >/dev/null || { echo 'Run this script in AWS CloudShell.'; exit 1; }
command -v python3 >/dev/null
command -v curl >/dev/null
aws sts get-caller-identity >/dev/null
REGION="${RONDIVOU_REGION:-eu-west-3}"
BUNDLE="${RONDIVOU_BUNDLE:-micro_3_0}"
BLUEPRINT="ubuntu_24_04"
INSTANCE="rondivou-$(date -u +%Y%m%d%H%M%S)"
BUCKET="${INSTANCE}-$(python3 -c 'import secrets;print(secrets.token_hex(4))')"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
aws lightsail get-bundles --region "$REGION" --output json > "$WORK/bundles.json"
python3 - "$WORK/bundles.json" "$BUNDLE" <<'PY'
import json,sys
bundle=next((b for b in json.load(open(sys.argv[1]))['bundles'] if b['bundleId']==sys.argv[2] and b['isActive']),None)
if not bundle or bundle['price']>10 or bundle['ramSizeInGb']<1:
 raise SystemExit('Bundle unavailable or exceeds the $10/month guard. Review the bundle and region before deployment.')
print(f"Lightsail: {bundle['ramSizeInGb']} GB RAM, {bundle['diskSizeInGb']} GB disk, ${bundle['price']}/month base price in this region.")
print('This is a paid AWS resource. Credits may cover eligible charges; check credit eligibility and expiry in Billing.')
print('Temporary S3 storage, tax, excess transfer and optional snapshots may cost extra. No paid domain is purchased.')
PY
aws lightsail get-blueprints --region "$REGION" --output json > "$WORK/blueprints.json"
python3 - "$WORK/blueprints.json" "$BLUEPRINT" <<'PY'
import json,sys
assert any(b['blueprintId']==sys.argv[2] and b['isActive'] for b in json.load(open(sys.argv[1]))['blueprints']), 'Ubuntu blueprint unavailable in selected region'
PY
echo 'Check AWS Billing > Credits before continuing. Credits do not automatically stop spending when exhausted.'
read -r -p 'Create this Lightsail server and its attached static IP? Type DEPLOY: ' ANSWER
[[ "$ANSWER" == 'DEPLOY' ]] || { echo 'No resources created.'; exit 0; }

# This archive is an explicit source-only list. Never include .env, .data or node_modules.
tar -czf "$WORK/source.tgz" Dockerfile .dockerignore package.json package-lock.json src public test README.md DEPLOYMENT.md .env.example
printf 'RONDIVOU_REGION=%q\nINSTANCE=%q\nBUCKET=%q\n' "$REGION" "$INSTANCE" "$BUCKET" > .deployment-state.env
if [[ "$REGION" == 'us-east-1' ]]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
aws s3 cp "$WORK/source.tgz" "s3://$BUCKET/source.tgz" --region "$REGION" --only-show-errors
aws lightsail allocate-static-ip --region "$REGION" --static-ip-name "$INSTANCE-ip" >/dev/null
IP="$(aws lightsail get-static-ip --region "$REGION" --static-ip-name "$INSTANCE-ip" --query staticIp.ipAddress --output text)"
URL="https://${IP}.sslip.io"
SOURCE_URL="$(aws s3 presign "s3://$BUCKET/source.tgz" --region "$REGION" --expires-in 7200)"
export SOURCE_URL URL
python3 - deploy/bootstrap.sh "$WORK/user-data.sh" <<'PY'
import os,pathlib,shlex,sys
script=pathlib.Path(sys.argv[1]).read_text()
header='#!/usr/bin/env bash\nSOURCE_URL='+shlex.quote(os.environ['SOURCE_URL'])+'\nPUBLIC_URL='+shlex.quote(os.environ['URL'])+'\n'
pathlib.Path(sys.argv[2]).write_text(header+script)
PY
printf 'URL=%q\n' "$URL" >> .deployment-state.env
aws lightsail create-instances --region "$REGION" --instance-names "$INSTANCE" --blueprint-id "$BLUEPRINT" --bundle-id "$BUNDLE" --user-data "file://$WORK/user-data.sh" --tags key=application,value=rondivou >/dev/null
echo 'Server requested. Waiting for it to be running...'
READY=false
for attempt in $(seq 1 90); do
  STATUS="$(aws lightsail get-instance-state --region "$REGION" --instance-name "$INSTANCE" --query state.name --output text)"
  if [[ "$STATUS" == running ]]; then READY=true; break; fi
  sleep 5
done
[[ "$READY" == true ]] || { echo 'Instance is not ready yet. Resource names are in .deployment-state.env.'; exit 1; }
aws lightsail attach-static-ip --region "$REGION" --static-ip-name "$INSTANCE-ip" --instance-name "$INSTANCE" >/dev/null
aws lightsail put-instance-public-ports --region "$REGION" --instance-name "$INSTANCE" --port-infos '[{"fromPort":22,"toPort":22,"protocol":"tcp","cidrListAliases":["lightsail-connect"]},{"fromPort":80,"toPort":80,"protocol":"tcp","cidrs":["0.0.0.0/0"]},{"fromPort":443,"toPort":443,"protocol":"tcp","cidrs":["0.0.0.0/0"]}]' >/dev/null
echo 'Installing the application and obtaining HTTPS. This can take several minutes...'
HEALTHY=false
for attempt in $(seq 1 120); do
  if curl --fail --silent --max-time 10 "$URL/health" -o "$WORK/health.json"; then
    if python3 -c 'import json,sys;sys.exit(json.load(open(sys.argv[1])).get("status")!="ok")' "$WORK/health.json"; then HEALTHY=true; break; fi
  fi
  sleep 10
done
if [[ "$HEALTHY" != true ]]; then
  echo 'Deployment needs inspection. Open Lightsail browser SSH and check /var/log/cloud-init-output.log and sudo docker logs rondivou.'
  echo 'Created resources are recorded in .deployment-state.env. Do not re-run blindly: it would create another server.'
  exit 1
fi
aws s3 rm "s3://$BUCKET/source.tgz" --region "$REGION" --only-show-errors
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
printf '\nYour website: %s\n' "$URL"
echo "Open Lightsail > $INSTANCE > Connect using SSH. Read the private login password there using: sudo cat /opt/rondivou/admin-password"
echo 'Do not paste that password into chat. Next, configure Meta and Telegram on the server as explained in README.md.'
