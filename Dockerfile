FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY config.example.yaml ./
COPY src ./src
COPY tools ./tools
COPY scripts ./scripts
COPY examples/personas ./examples/personas

RUN npm run build

EXPOSE 7777

CMD ["node", "dist/index.js"]
