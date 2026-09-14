FROM node:20.18.1-bookworm-slim

ARG YT_DLP_VERSION=2026.08.19

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core fonts-liberation fonts-noto-color-emoji ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY assets ./assets

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
