# syntax=docker/dockerfile:1
# Judge-friendly image: one container serves the web app and API on :8080.

# ---- whisper.cpp (speech transcription) -------------------------------------
FROM node:24-bookworm-slim AS whisper
ARG WHISPER_TAG=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${WHISPER_TAG}" https://github.com/ggml-org/whisper.cpp.git .
# Static, non-native build so the binary runs on any host CPU.
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF \
      -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
 && cmake --build build --config Release -j"$(nproc)" --target whisper-cli
RUN bash models/download-ggml-model.sh base

# ---- build the web app --------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run vision:prepare \
 && npm run build --workspace @examguard/web

# ---- runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/contracts/package.json packages/contracts/
# Only the API (vite-node) and contracts dependencies; no Electron/Playwright.
RUN npm ci --no-audit --no-fund --workspace @examguard/api --workspace @examguard/contracts \
 && npm cache clean --force
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/vendor/yolo_server.py apps/api/vendor/yolo_server.py
COPY packages/contracts packages/contracts
# The API imports the shared vision CSP constants from the web sources.
COPY apps/web/src/features/integrity/visionPolicy.ts apps/web/src/features/integrity/visionPolicy.ts
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=whisper /src/build/bin/whisper-cli /opt/whisper/whisper-cli
COPY --from=whisper /src/models/ggml-base.bin /opt/whisper/ggml-base.bin
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV NODE_ENV=development \
    HOST=0.0.0.0 \
    PORT=8080 \
    COOKIE_SECURE=false \
    SERVE_WEB_DIST=/app/apps/web/dist \
    DATABASE_PATH=/data/exam-anti-cheat.sqlite \
    WHISPER_BIN=/opt/whisper/whisper-cli \
    WHISPER_MODEL_PATH=/opt/whisper/ggml-base.bin \
    FFMPEG_BIN=ffmpeg

# The base image's `node` user (uid 1000) owns the data directory.
RUN mkdir -p /data && chown node:node /data && chmod +x /usr/local/bin/entrypoint.sh
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/auth/csrf >/dev/null || exit 1
ENTRYPOINT ["entrypoint.sh"]

# ---- optional: server-side OWL-ViT (large; only built with `--profile vision`) -
FROM runtime AS vision
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/vision-venv \
 && /opt/vision-venv/bin/pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && /opt/vision-venv/bin/pip install --no-cache-dir transformers Pillow
ENV ENABLE_BACKEND_VISION=true \
    VISION_PYTHON=/opt/vision-venv/bin/python \
    HF_HOME=/data/hf-cache
USER node

# Default target: the lightweight runtime image (must stay last).
FROM runtime
