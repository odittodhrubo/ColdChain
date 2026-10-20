# Dev image: source is bind-mounted by infra/docker-compose.yml; node_modules stay in the image.
FROM node:22-bookworm-slim
# better-sqlite3 and bcrypt are native addons; with no prebuilt binary for this Node they compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]
