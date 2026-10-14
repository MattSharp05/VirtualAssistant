# JARVIS: headless assistant (dashboard + optional Telegram) that starts and steers Claude Code cloud sessions.
# The AI runs on Anthropic's cloud; this container is just the app shell plus the Claude Code CLI.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# npm workspaces: install only the server (root) and the shared package; never the desk app,
# which pulls in Electron and the UI toolchain.
COPY package.json package-lock.json tsconfig.json ./
COPY shared/package.json ./shared/package.json
COPY desk/package.json ./desk/package.json
RUN npm ci --workspace=@jarvis/shared --include-workspace-root
COPY shared ./shared
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev --workspace=@jarvis/shared --include-workspace-root

# Speech to text for Telegram voice notes (ADR 0005): whisper.cpp built from source (CPU, portable),
# plus the English base model (~142 MB) from Hugging Face.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /build -j"$(nproc)" --target whisper-cli \
 && curl -fsSL -o /ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

FROM node:22-bookworm-slim
# Pin with --build-arg CLAUDE_CODE_VERSION=2.1.296 if an update ever breaks `--cloud`.
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# Everything that must survive a rebuild lives on the /data volume:
# the Claude login (CLAUDE_CONFIG_DIR) and JARVIS's job list (DATA_DIR).
ENV NODE_ENV=production \
    CLAUDE_CONFIG_DIR=/data/claude \
    DATA_DIR=/data/jarvis \
    WHISPER_BIN=/usr/local/bin/whisper-cli \
    WHISPER_MODEL=/opt/whisper/ggml-base.en.bin
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /ggml-base.en.bin /opt/whisper/ggml-base.en.bin
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./
VOLUME /data
EXPOSE 8080 8081
CMD ["node", "dist/src/index.js"]
