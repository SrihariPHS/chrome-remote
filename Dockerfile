FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb xauth ca-certificates fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    IW_CHROME=/usr/bin/chromium \
    IW_DATA=/data \
    IW_PORT=8787 \
    IW_HEADFUL=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs llms.txt ./
COPY src ./src
COPY public ./public
COPY fixtures ./fixtures

RUN mkdir -p /data /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && chown -R node:node /data /app
USER node
EXPOSE 8787

CMD ["sh", "-c", "Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp -ac & export DISPLAY=:99; for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done; exec node server.mjs"]
