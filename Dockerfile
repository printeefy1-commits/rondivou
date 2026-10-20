FROM scratch AS npmcache

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca --mount=type=bind,from=npmcache,target=/mnt/npm-cache \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    if [ -d /mnt/npm-cache/_cacache ]; then \
      mkdir -p /tmp/npm-cache && cp -a /mnt/npm-cache/_cacache /tmp/npm-cache/ && \
      npm ci --offline --cache /tmp/npm-cache --ignore-scripts --no-audit --no-fund && rm -rf /tmp/npm-cache; \
    else npm ci --ignore-scripts --no-audit --no-fund; fi
COPY src ./src
COPY test ./test
RUN npm test

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 COOKIE_SECURE=true DATABASE_PATH=/data/rondivou.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
