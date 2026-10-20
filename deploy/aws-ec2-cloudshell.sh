#!/usr/bin/env bash
# Execute in the user's authenticated AWS CloudShell. No access keys are requested.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
for command in aws python3 curl git; do command -v "$command" >/dev/null || { echo "Missing $command. Run in AWS CloudShell."; exit 1; }; done
STATE=.deployment-ec2-state.env
[[ ! -e "$STATE" ]] || { echo "A previous attempt is recorded in $STATE. Inspect its resources before creating another server."; exit 1; }
REGION="${RONDIVOU_REGION:-eu-north-1}"
AMI="${RONDIVOU_AMI:-ami-0a7acf71650e53201}"
[[ "$REGION" == eu-north-1 || -n "${RONDIVOU_AMI:-}" ]] || { echo 'For another region, explicitly provide its RONDIVOU_AMI.'; exit 1; }
NAME="rondivou-$(date -u +%Y%m%d%H%M%S)"
WORK="$(mktemp -d)"
trap 'code=$?; rm -rf "$WORK"; if [[ $code != 0 && -e "$STATE" ]]; then echo "Deployment interrupted. Resource IDs are in $STATE. Do not re-run without inspecting them."; fi' EXIT
aws sts get-caller-identity >/dev/null
echo 'Checking access in the region where your EC2 dry-run succeeded...'
VPC="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
[[ "$VPC" != None && -n "$VPC" ]] || { echo 'No default VPC. No resources created. An existing public VPC must be selected first.'; exit 1; }
SUBNET="$(aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true Name=state,Values=available --query 'Subnets[0].SubnetId' --output text)"
[[ "$SUBNET" != None && -n "$SUBNET" ]] || { echo 'No available default subnet. No resources created.'; exit 1; }
aws ec2 describe-images --region "$REGION" --image-ids "$AMI" --output json > "$WORK/image.json"
ROOT_DEVICE="$(python3 - "$WORK/image.json" <<'PY'
import json,sys
images=json.load(open(sys.argv[1]))['Images']
if len(images)!=1 or images[0]['Architecture']!='x86_64' or images[0]['State']!='available':
 raise SystemExit('Expected one available x86_64 AMI in this region.')
print(images[0]['RootDeviceName'])
PY
)"
COMMIT="$(git rev-parse --verify HEAD)"
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || exit 1
SOURCE_URL="https://codeload.github.com/printeefy1-commits/rondivou/tar.gz/$COMMIT"
# Verify public source availability BEFORE creating any AWS resources. No GitHub credentials go to the VM.
curl --fail --silent --show-error --location --max-time 60 "$SOURCE_URL" -o "$WORK/source.tgz"
SOURCE_SHA256="$(sha256sum "$WORK/source.tgz" | cut -d ' ' -f 1)"
curl --fail --silent --show-error --max-time 60 https://ip-ranges.amazonaws.com/ip-ranges.json -o "$WORK/ip-ranges.json"
python3 - "$WORK/ip-ranges.json" "$REGION" "$WORK/ingress.json" <<'PY'
import json,sys
prefixes=[p['ip_prefix'] for p in json.load(open(sys.argv[1]))['prefixes'] if p['service']=='EC2_INSTANCE_CONNECT' and p['region']==sys.argv[2]]
if not prefixes: raise SystemExit('No EC2 Instance Connect IPv4 ranges found. No resources created.')
rules=[{'IpProtocol':'tcp','FromPort':p,'ToPort':p,'IpRanges':[{'CidrIp':'0.0.0.0/0'}]} for p in [80,443]]
rules.append({'IpProtocol':'tcp','FromPort':22,'ToPort':22,'IpRanges':[{'CidrIp':p,'Description':'AWS browser SSH'} for p in prefixes]})
json.dump(rules,open(sys.argv[3],'w'))
PY
python3 - "$ROOT_DEVICE" "$WORK/disks.json" <<'PY'
import json,sys
json.dump([{'DeviceName':sys.argv[1],'Ebs':{'VolumeSize':16,'VolumeType':'gp3','Encrypted':True,'DeleteOnTermination':True}}],open(sys.argv[2],'w'))
PY
# Check the planned disk, CPU-credit mode, metadata settings and tags before creating billable resources.
if aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type t3.micro --count 1 \
  --subnet-id "$SUBNET" --block-device-mappings "file://$WORK/disks.json" \
  --credit-specification CpuCredits=standard --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=application,Value=rondivou}]" \
  --dry-run > "$WORK/dryrun.out" 2> "$WORK/dryrun.error"; then
  echo 'Unexpected dry-run response. No deployment resources created.'; exit 1
fi
if ! python3 - "$WORK/dryrun.error" <<'PY'
import pathlib,sys
sys.exit('DryRunOperation' not in pathlib.Path(sys.argv[1]).read_text())
PY
then
  cat "$WORK/dryrun.error"
  echo 'The planned configuration did not pass the authorization dry-run. No deployment resources created.'
  exit 1
fi
echo
echo "Plan: ONE t3.micro in $REGION, 16 GiB encrypted gp3 root disk, ONE Elastic IPv4 address."
echo 't3 CPU credits: standard mode, without unlimited CPU credit charges. No load balancer, NAT gateway, S3 bucket or paid domain.'
echo 'All of EC2, EBS and public IPv4 are billable. Check current regional pricing and that your credits cover these services.'
echo 'An estimate is not a spending cap; credits do not automatically stop resources when exhausted.'
echo 'Disk data survives reboot and container replacement. Terminating the instance deletes the root disk; back up data first.'
read -r -p 'After reviewing the plan and AWS Billing, type DEPLOY to create these resources: ' ANSWER
[[ "$ANSWER" == DEPLOY ]] || { echo 'No resources created.'; exit 0; }
printf 'REGION=%q\nNAME=%q\n' "$REGION" "$NAME" > "$STATE"
SG_ID="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" --description 'Rondivou HTTPS and AWS browser SSH' --vpc-id "$VPC" --query GroupId --output text)"
printf 'SG_ID=%q\n' "$SG_ID" >> "$STATE"
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --ip-permissions "file://$WORK/ingress.json" >/dev/null
aws ec2 allocate-address --region "$REGION" --domain vpc --output json > "$WORK/address.json"
ALLOCATION_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["AllocationId"])' "$WORK/address.json")"
IP="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["PublicIp"])' "$WORK/address.json")"
URL="https://${IP}.sslip.io"
printf 'ALLOCATION_ID=%q\nIP=%q\nURL=%q\n' "$ALLOCATION_ID" "$IP" "$URL" >> "$STATE"
export SOURCE_URL SOURCE_SHA256 URL
python3 - deploy/ec2-bootstrap.sh "$WORK/user-data.sh" <<'PY'
import os,pathlib,shlex,sys
header='#!/usr/bin/env bash\n'
for key in ['SOURCE_URL','SOURCE_SHA256']: header+=key+'='+shlex.quote(os.environ[key])+'\n'
header+='PUBLIC_URL='+shlex.quote(os.environ['URL'])+'\n'
script=header+pathlib.Path(sys.argv[1]).read_text()
if len(script.encode())>16384:raise SystemExit('EC2 user-data exceeds its 16 KiB limit.')
pathlib.Path(sys.argv[2]).write_text(script)
PY
python3 - "$SUBNET" "$SG_ID" "$WORK/network.json" <<'PY'
import json,sys
json.dump([{'DeviceIndex':0,'SubnetId':sys.argv[1],'Groups':[sys.argv[2]],'AssociatePublicIpAddress':True,'DeleteOnTermination':True}],open(sys.argv[3],'w'))
PY
INSTANCE_ID="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type t3.micro --count 1 \
  --network-interfaces "file://$WORK/network.json" --block-device-mappings "file://$WORK/disks.json" \
  --credit-specification CpuCredits=standard --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
  --user-data "file://$WORK/user-data.sh" --client-token "$NAME" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=application,Value=rondivou}]" \
  --query 'Instances[0].InstanceId' --output text)"
printf 'INSTANCE_ID=%q\n' "$INSTANCE_ID" >> "$STATE"
echo "Instance requested: $INSTANCE_ID. Waiting for startup..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOCATION_ID" >/dev/null
echo 'Installing the application and HTTPS. This can take several minutes...'
HEALTHY=false
for attempt in $(seq 1 120); do
  if curl --fail --silent --max-time 10 "$URL/health" -o "$WORK/health.json"; then
    if python3 -c 'import json,sys;sys.exit(json.load(open(sys.argv[1])).get("status")!="ok")' "$WORK/health.json"; then HEALTHY=true; break; fi
  fi
  sleep 10
done
if [[ "$HEALTHY" != true ]]; then
  echo "Not yet healthy. In EC2 > Instances > $INSTANCE_ID > Connect, use EC2 Instance Connect with user ec2-user."
  echo 'Inspect: sudo tail -n 60 /var/log/cloud-init-output.log ; sudo docker logs rondivou'
  echo 'If Instance Connect is denied, the organization administrator must allow it. Do not send credentials in chat.'
  exit 1
fi
printf '\nWebsite: %s\n' "$URL"
echo "EC2 > Instances > $INSTANCE_ID > Connect > EC2 Instance Connect; username: ec2-user."
echo 'In that private SSH terminal: sudo cat /opt/rondivou/admin-password'
echo 'Configure Meta and Telegram in /opt/rondivou/runtime.env next. The site is not yet connected to those accounts.'
