# ── Stage 1: build TypeScript ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Только prod-зависимости.
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled JS
COPY --from=builder /app/dist ./dist

# Persistent data dirs (will be mounted as volumes)
RUN mkdir -p /app/logs /app/data

EXPOSE 3030 3031
