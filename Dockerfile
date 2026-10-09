FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_USE_ENV_PROXY=1
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=environment_ca,required=false \
    if [ -f /run/secrets/environment_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/environment_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 && mkdir -p /data && chown node:node /data
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
ENV NODE_ENV=production CRS_DATA_DIR=/data PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
