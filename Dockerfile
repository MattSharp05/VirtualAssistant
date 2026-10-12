# JARVIS: headless assistant (dashboard + optional Telegram) that starts and steers Claude Code cloud sessions.
# The AI runs on Anthropic's cloud; this container is just the app shell plus the Claude Code CLI.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# Pin with --build-arg CLAUDE_CODE_VERSION=2.1.296 if an update ever breaks `--cloud`.
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# Everything that must survive a rebuild lives on the /data volume:
# the Claude login (CLAUDE_CONFIG_DIR) and JARVIS's job list (DATA_DIR).
ENV NODE_ENV=production \
    CLAUDE_CONFIG_DIR=/data/claude \
    DATA_DIR=/data/jarvis
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
