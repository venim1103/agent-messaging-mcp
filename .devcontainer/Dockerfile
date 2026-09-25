FROM docker.io/library/node:24-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global npm@12.1.0