FROM node:22-alpine

WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci --omit=dev

COPY api/src ./src
# Собранная витрина отдаётся тем же процессом — отдельный веб-сервер не нужен.
COPY web/dist /app/web/dist

RUN mkdir -p var/uploads && chown -R node:node /app
USER node

ENV NODE_ENV=production PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1

CMD ["node", "src/server.js"]
