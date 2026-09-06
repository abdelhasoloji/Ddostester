# Pin a specific patch release for reproducible builds; for full immutability
# replace the tag with a @sha256 digest.
FROM node:22.20.0-alpine
WORKDIR /app
COPY *.mjs ./
USER node
CMD ["node", "server.mjs"]
