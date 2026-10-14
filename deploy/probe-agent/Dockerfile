FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY --chmod=644 deploy/probe-agent/probe-agent.mjs ./probe-agent.mjs
COPY --chmod=644 deploy/probe-agent/quality.mjs ./quality.mjs
USER node
ENV PROBE_AGENT_BIND=0.0.0.0
EXPOSE 8099
CMD ["node", "probe-agent.mjs"]
