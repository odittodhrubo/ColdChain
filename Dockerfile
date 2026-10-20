# Stage 1: Build Frontend React App
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npx vite build 

# Stage 2: Build Backend Node App
FROM node:22-bookworm-slim AS backend-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend ./
RUN npm run build && npm prune --omit=dev

# Stage 3: Production Runner
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=backend-build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=backend-build --chown=node:node /app/backend/dist ./dist
COPY --from=backend-build --chown=node:node /app/backend/package.json ./
COPY --from=frontend-build --chown=node:node /app/frontend/dist ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
