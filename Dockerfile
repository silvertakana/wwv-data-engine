FROM node:22-slim AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Use hoisted linker to prevent symlink issues when copying node_modules between docker stages
RUN pnpm config set node-linker hoisted

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm run build

# Production Stage
FROM node:22-slim

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Create directory for Seeders
RUN mkdir -p /app/seeders

ENV SEEDERS_DIR=/app/seeders
ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "dist/server.js"]
