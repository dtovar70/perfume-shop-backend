# syntax=docker/dockerfile:1

# Node 24, as required by the README (Prerequisites) and @types/node. Debian slim (glibc) rather
# than Alpine: argon2 and the other native modules ship prebuilt glibc binaries.
ARG NODE_IMAGE=node:24-bookworm-slim

# --- Build: full dependency tree, compile to dist/ ---------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Runtime: production dependencies and dist/ only, as the unprivileged `node` user ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Local-disk storage folders (unused in production, where Cloudinary is mandatory) must still be
# writable by the app user if the driver ever falls back to disk.
RUN mkdir -p uploads private-uploads && chown node:node uploads private-uploads
USER node
EXPOSE 3000
# No curl in the slim image: Node's own fetch probes the API (which also pings the database).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
