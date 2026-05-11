FROM node:22-slim AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Use hoisted linker to prevent symlink issues when copying node_modules between docker stages
RUN pnpm config set node-linker hoisted

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

# Install runtime dependencies (wget/unzip for seeders, openssl for Prisma)
RUN apt-get update && apt-get install -y wget unzip openssl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Copy built artifacts and fully resolved production node_modules from builder
# This avoids native recompilation issues (better-sqlite3) in the slim runner
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/seeders ./seeders

# Create directory for SQLite DB
RUN mkdir -p /app/data

ENV NODE_ENV=production


EXPOSE 5001

CMD ["node", "dist/server.js"]
