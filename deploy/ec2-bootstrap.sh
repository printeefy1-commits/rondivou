# Appended to EC2 user-data. Intended for a NEW Amazon Linux 2023 x86_64 instance.
set -euo pipefail
umask 077
dnf install -y docker openssl
systemctl enable --now docker
mkdir -p /opt/rondivou /var/lib/rondivou/database /var/lib/rondivou/caddy
curl --fail --silent --show-error --location --retry 5 "$SOURCE_URL" -o /opt/rondivou/source.tgz
printf '%s  %s\n' "$SOURCE_SHA256" /opt/rondivou/source.tgz | sha256sum --check -
tar -xzf /opt/rondivou/source.tgz --strip-components=1 -C /opt/rondivou
rm /opt/rondivou/source.tgz
cd /opt/rondivou
# Install and test in the same official Node runtime used by the application.
# No buildx plugin is required from the Amazon Linux Docker package.
chown -R 1000:1000 /opt/rondivou /var/lib/rondivou/database
docker pull node:24-bookworm-slim
NODE_IMAGE="$(docker image inspect node:24-bookworm-slim --format '{{.Id}}')"
docker run --rm --user 1000:1000 --env npm_config_cache=/tmp/npm-cache \
  --mount type=bind,source=/opt/rondivou,target=/app --workdir /app \
  "$NODE_IMAGE" sh -c 'npm ci --ignore-scripts --no-audit --no-fund && npm test'
chown -R root:root /opt/rondivou
chmod 755 /opt/rondivou
chmod 700 /var/lib/rondivou/database
openssl rand -hex 24 > admin-password
chmod 600 admin-password
{
  printf 'ADMIN_PASSWORD=%s\n' "$(cat admin-password)"
  printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL"
  printf 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\nCOOKIE_SECURE=true\nDATABASE_PATH=/data/rondivou.sqlite\n'
} > runtime.env
chmod 600 runtime.env
docker run -d --name rondivou --restart unless-stopped --network host --user 1000:1000 \
  --env-file /opt/rondivou/runtime.env --workdir /app \
  --mount type=bind,source=/opt/rondivou,target=/app,readonly \
  --mount type=bind,source=/var/lib/rondivou/database,target=/data \
  --read-only --tmpfs /tmp --log-opt max-size=10m --log-opt max-file=3 \
  "$NODE_IMAGE" node src/server.js
DOMAIN="${PUBLIC_URL#https://}"
printf '%s {\n  reverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > Caddyfile
chmod 644 Caddyfile
docker run -d --name rondivou-https --restart unless-stopped --network host \
  --mount type=bind,source=/opt/rondivou/Caddyfile,target=/etc/caddy/Caddyfile,readonly \
  --mount type=bind,source=/var/lib/rondivou/caddy,target=/data \
  --log-opt max-size=10m --log-opt max-file=3 caddy:2
