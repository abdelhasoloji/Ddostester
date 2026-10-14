# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --ignore-scripts
COPY backend ./backend
COPY frontend ./frontend
COPY scripts ./scripts
COPY standards ./standards
ARG SHIELDTEST_COMMIT=unversioned-lab
ARG SHIELDTEST_BUILD=lab
ENV SHIELDTEST_COMMIT=$SHIELDTEST_COMMIT SHIELDTEST_BUILD=$SHIELDTEST_BUILD
RUN npm run build -w backend && npm run build -w frontend && node scripts/release-manifest.mjs
RUN npm prune --omit=dev --ignore-scripts && node scripts/operations/assert-portable-runtime.mjs node_modules

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/standards ./standards
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/scripts/fleet/heartbeat-agent.mjs ./scripts/fleet/heartbeat-agent.mjs
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist
COPY --from=build --chown=node:node /app/release-manifest.json ./release-manifest.json
USER node
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
