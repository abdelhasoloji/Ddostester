# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# Install every workspace's deps (incl. dev) so both the API and the UI can build.
RUN npm install --workspaces --include-workspace-root || npm install
COPY backend ./backend
COPY frontend ./frontend
# Build the API (backend/dist) and the UI (frontend/dist). The runtime server
# serves the UI from ../../frontend/dist when it exists, so both must ship.
RUN npm run build -w backend && npm run build -w frontend

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
# Ship the built UI so the api container serves the interface, not just the API.
# Resolves to /app/frontend/dist — where the server looks (../../frontend/dist
# relative to backend/dist/server.js).
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
