# Dev image: source is bind-mounted by infra/docker-compose.yml; node_modules stay in the image.
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
