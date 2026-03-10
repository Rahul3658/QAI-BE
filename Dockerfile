# ---------- Stage 1 : Build ----------
FROM node:20.8.0 AS builder

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy source code
COPY . .


# ---------- Stage 2 : Production ----------
FROM node:20.8.0-alpine

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app /app

# Remove dev dependencies
RUN npm prune --production

# Expose backend port
EXPOSE 5000

# Start server
CMD ["node", "server.js"]
