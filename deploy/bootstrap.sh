# Appended to a root cloud-init script by aws-cloudshell.sh. Never run on an existing server.
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io ca-certificates curl openssl
systemctl enable --now docker
mkdir -p /opt/rondivou /var/lib/rondivou/database /var/lib/rondivou/caddy
chown 1000:1000 /var/lib/rondivou/database
chmod 700 /var/lib/rondivou/database
# Do not log the signed URL, generated password, or runtime environment.
curl --fail --silent --show-error --retry 5 "$SOURCE_URL" -o /opt/rondivou/source.tgz
unset SOURCE_URL
tar -xzf /opt/rondivou/source.tgz -C /opt/rondivou
rm /opt/rondivou/source.tgz
cd /opt/rondivou
openssl rand -hex 24 > admin-password
chmod 600 admin-password
{
  printf 'ADMIN_PASSWORD=%s\n' "$(cat admin-password)"
  printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL"
  printf 'HOST=127.0.0.1\nPORT=3000\nCOOKIE_SECURE=true\nDATABASE_PATH=/data/rondivou.sqlite\n'
} > runtime.env
chmod 600 runtime.env
docker build -t rondivou:production .
docker run -d --name rondivou --restart unless-stopped --network host --env-file /opt/rondivou/runtime.env --mount type=bind,source=/var/lib/rondivou/database,target=/data --log-opt max-size=10m --log-opt max-file=3 rondivou:production
DOMAIN="${PUBLIC_URL#https://}"
printf '%s {\n  reverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > Caddyfile
docker run -d --name rondivou-https --restart unless-stopped --network host --mount type=bind,source=/opt/rondivou/Caddyfile,target=/etc/caddy/Caddyfile,readonly --mount type=bind,source=/var/lib/rondivou/caddy,target=/data --log-opt max-size=10m --log-opt max-file=3 caddy:2
