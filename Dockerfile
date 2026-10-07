# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim

RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then \
      printf 'Acquire::https::CaInfo "/run/secrets/build_ca";\n' > /etc/apt/apt.conf.d/99-build-ca; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-build-ca

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STOCK_DB_PATH=/var/lib/comptoir/data/stock.sqlite \
    STOCK_UPLOAD_DIR=/var/lib/comptoir/uploads

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN chmod -R a+rX /app \
    && install -d -o node -g node -m 0750 /var/lib/comptoir /var/lib/comptoir/data /var/lib/comptoir/uploads

COPY --chmod=0555 deploy/docker-entrypoint.sh /usr/local/bin/comptoir-entrypoint

VOLUME ["/var/lib/comptoir"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/comptoir-entrypoint"]
CMD ["node", "server.js"]
