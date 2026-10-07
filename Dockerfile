# nexus-executor — self-contained remote job runner image.
# Two-stage build: full deps + tsc build, then a slim runtime with git.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 1001 executor \
  && useradd -u 1001 -g executor -m executor \
  && mkdir -p /data/workspaces \
  && chown -R executor:executor /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations ship with the sources; the runtime reads them at boot.
COPY src/migrations ./src/migrations
ENV NODE_ENV=production
EXPOSE 4099
USER executor
CMD ["node", "dist/main.js"]
