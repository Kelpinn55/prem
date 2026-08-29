# Dockerfile untuk backend Rizz Studio
# Pastikan file ini ada di root repo backend (bareng server.js & package.json)

FROM node:20-slim

# Install python3/pip untuk yt-dlp (ffmpeg sudah otomatis ke-install via npm "ffmpeg-static")
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl && \
    pip3 install --no-cache-dir -U yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p tmp public/downloads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
