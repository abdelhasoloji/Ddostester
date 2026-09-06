FROM node:22.20.0-alpine
WORKDIR /app
COPY lib ./lib
COPY generator/*.mjs ./generator/
USER node
CMD ["node", "generator/generate.mjs"]
