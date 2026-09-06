# Pin a specific patch release for reproducible builds; for full immutability
# replace the tag with a @sha256 digest. Built from the ./lab context so the
# shared lib/ (net-guard) is available at ../lib relative to the module.
FROM node:22.20.0-alpine
WORKDIR /app
COPY lib ./lib
COPY synthetic-reflector/*.mjs ./synthetic-reflector/
USER node
CMD ["node", "synthetic-reflector/server.mjs"]
