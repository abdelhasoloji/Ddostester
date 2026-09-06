FROM node:22.20.0-alpine
WORKDIR /app
COPY lib ./lib
COPY scrubber/*.mjs ./scrubber/
USER node
CMD ["node", "scrubber/server.mjs"]
