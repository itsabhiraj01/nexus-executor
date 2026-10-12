# nexus-executor — self-contained remote job runner image.
# Two-stage build: full deps + tsc build, then a slim runtime with git.
# node-pty (terminal sessions, 0.3.1+) has no published prebuilds: the C++
# toolchain is build-stage only, and the pruned node_modules — with the
# compiled native binding — carry over into the runtime stage.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# node-pty has no published prebuilds — the toolchain is build-stage only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tmux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 1001 executor \
  && useradd -u 1001 -g executor -m executor \
  && mkdir -p /data/workspaces \
  && chown -R executor:executor /data
WORKDIR /app
COPY package.json package-lock.json ./
# Prod node_modules come pruned from the build stage (node-pty is native —
# the runtime stage has no toolchain to rebuild it).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Migrations ship with the sources; the runtime reads them at boot.
COPY src/migrations ./src/migrations
ENV NODE_ENV=production
EXPOSE 4099
USER executor
CMD ["node", "dist/main.js"]
