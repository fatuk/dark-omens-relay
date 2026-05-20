# ── Stage 1: build TypeScript ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Dev stage: для docker-compose.dev.yml ─────────────────────────────────────
# Содержит ВСЕ зависимости (включая dev — tsx), но НЕ копирует src и не компилит:
# код приходит из bind-mount, запускается через `tsx watch` с авто-перезагрузкой.
FROM node:22-alpine AS dev

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./

RUN mkdir -p /app/logs /app/data

EXPOSE 3030 3031

# ── Stage 2: production image ─────────────────────────────────────────────────
# ВАЖНО: production — последняя стадия, чтобы `docker build` без --target
# собирал именно её (а не dev).
FROM node:22-alpine AS production

WORKDIR /app

# Только prod-зависимости.
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled JS
COPY --from=builder /app/dist ./dist

# Persistent data dirs (will be mounted as volumes). Делает их writable
# для встроенного в base-image юзера `node` (uid=1000) — иначе процесс под
# не-root не сможет создать логи / открыть SQLite в volume.
RUN mkdir -p /app/logs /app/data && chown -R node:node /app

# Запускаем не от root — стандартный hygiene для контейнеров.
USER node

EXPOSE 3030 3031
