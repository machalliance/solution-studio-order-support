# One image for all three apps (agent, escalation desk, storefront). docker-compose.yml starts three containers from it,
# each with its own command. Self-contained: dependencies installed and both Next apps built at image-build time, no bind mounts.
FROM node:26-bookworm-slim

# Security: apply the Debian security updates released since the base image was built, and refresh npm (the base image ships an npm
# whose bundled packages scanners flag). Done as root, before dropping privileges.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
 && npm install -g npm@latest

# Runs as the unprivileged `node` user (built into the base image), not root. Everything under /app is owned by it, including the
# agent's data directory — so the agent-data volume, which is filled from the image the first time, is writable by it too.
WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first, so source edits don't re-install them.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/agent/package.json apps/agent/
COPY --chown=node:node apps/escalation-desk/package.json apps/escalation-desk/
COPY --chown=node:node apps/storefront/package.json apps/storefront/
RUN npm ci

COPY --chown=node:node . .

# The browser finds the agent at <the page's own hostname>:NEXT_PUBLIC_AGENT_PORT, and Next inlines that value when it
# BUILDS — so it is a build argument (docker-compose.yml passes it from AGENT_PORT), not a run-time setting.
ARG NEXT_PUBLIC_AGENT_PORT=3006
ARG NEXT_PUBLIC_AGENT_URL=
ENV NEXT_PUBLIC_AGENT_PORT=${NEXT_PUBLIC_AGENT_PORT} \
    NEXT_PUBLIC_AGENT_URL=${NEXT_PUBLIC_AGENT_URL}
RUN npm run build --workspace=apps/escalation-desk && npm run build --workspace=apps/storefront

# Build tooling (TypeScript, @types/*) is not needed to RUN anything — drop it. Smaller image, and fewer packages to scan.
# (tsx, which launches the agent, is a regular dependency.)
RUN npm prune --omit=dev

EXPOSE 3005 3006 3007

# The default command is the agent, so the default health check is the agent's. The Desk and storefront services override both the
# command and the health check in docker-compose.yml.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://localhost:'+(process.env.AGENT_PORT||3006)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "--workspace=apps/agent"]
