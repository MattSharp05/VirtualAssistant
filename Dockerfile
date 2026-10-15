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

# Text to speech for Telegram voice replies (ADR 0005): Piper's self-contained release build (C++,
# bundled onnxruntime + espeak-ng, no Python) and one British male voice from Hugging Face (~63 MB).
# rhasspy/piper is archived; its last release is the final standalone binary (piper1-gpl only ships a
# Python wheel). Both downloads are checksum-pinned.
FROM debian:bookworm-slim AS piper
ARG TARGETARCH
ARG PIPER_RELEASE=2023.11.14-2
ARG PIPER_VOICE=en_GB-alan-medium
ARG PIPER_VOICES_REF=v1.0.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64;  sum=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992 ;; \
      arm64) arch=aarch64; sum=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb ;; \
      *) echo "no Piper build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /piper.tar.gz "https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/piper_linux_${arch}.tar.gz"; \
    echo "${sum}  /piper.tar.gz" | sha256sum -c -; \
    mkdir -p /opt && tar -xzf /piper.tar.gz -C /opt; \
    rm -f /opt/piper/libtashkeel_model.ort; \
    mkdir -p /opt/piper/voices; \
    base="https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REF}/en/en_GB/alan/medium/${PIPER_VOICE}"; \
    curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx" "${base}.onnx"; \
    curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx.json" "${base}.onnx.json"; \
    cd /opt/piper/voices && printf '%s  %s\n' \
      0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330 "${PIPER_VOICE}.onnx" \
      c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e "${PIPER_VOICE}.onnx.json" \
      | sha256sum -c -

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
    WHISPER_MODEL=/opt/whisper/ggml-base.en.bin \
    PIPER_BIN=/opt/piper/piper \
    PIPER_MODEL=/opt/piper/voices/en_GB-alan-medium.onnx
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /ggml-base.en.bin /opt/whisper/ggml-base.en.bin
COPY --from=piper /opt/piper /opt/piper
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
