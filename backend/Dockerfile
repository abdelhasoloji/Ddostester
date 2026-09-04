# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/package.json
RUN npm install --workspaces --include-workspace-root || npm install
COPY backend ./backend
RUN npm run build -w backend

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/package.json
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
