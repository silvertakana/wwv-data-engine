FROM node:22-slim AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy package files (pnpm-workspace.yaml carries `nodeLinker: hoisted` so node_modules
# can be copied between docker stages without symlink breakage).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

# Force native prebuilt binary resolution. pnpm cache mounts often discard postinstall .node artifacts.
RUN pnpm rebuild better-sqlite3

# Copy source and build
COPY . .
RUN pnpm run build

# Development dependencies are retained because pnpm prune --prod aggressively rebuilds the hoisted structure, deleting prebuilt C++ binaries for better-sqlite3 and Rust engines for Prisma.

# Production Stage
FROM node:22-slim

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy built artifacts and fully resolved production node_modules from builder
# This avoids native recompilation issues (better-sqlite3) in the slim runner
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/seedData ./seedData
COPY --from=builder /app/prisma ./prisma

# Create directory for SQLite DB
RUN mkdir -p /app/data

ENV NODE_ENV=production


EXPOSE 5001

CMD ["node", "dist/server.js"]
