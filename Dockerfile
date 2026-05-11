FROM node:22-slim AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy package files
COPY package.json pnpm-lock.yaml ./


# Install dependencies
RUN pnpm config set ignore-scripts false
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm run build

# Production Stage
FROM node:22-slim

WORKDIR /app

# Install curl and unzip for dynamic seeders fetch
RUN apt-get update && apt-get install -y curl unzip && rm -rf /var/lib/apt/lists/*

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
