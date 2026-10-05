# MediaRent on Fly.io — zero npm dependencies, uses Node's built-in node:sqlite (needs Node >= 22.13).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    MEDIRENT_DATA_DIR=/data

WORKDIR /app
# No `npm install` needed: package.json has no dependencies.
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY scripts ./scripts
COPY samples ./samples
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

EXPOSE 8080
# Starts as root only to fix permissions on the mounted volume, then drops to the unprivileged `node` user.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
