# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
# Dependencies are installed from the lockfile only, so a build cannot pick up a
# version the lockfile never saw.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Migrations are deliberately not shipped here. They run as a separate step
# against the database, not from an app container that might race another
# replica to apply them.

# Numeric, because Kubernetes resolves nothing from /etc/passwd and rejects a
# pod whose runAsNonRoot user is named rather than numbered.
USER 10001:10001

EXPOSE 3000

# Exec form calling node directly. Going through npm or a shell would leave the
# shutdown handlers as dead code, because neither forwards SIGTERM.
CMD ["node", "dist/index.js"]
