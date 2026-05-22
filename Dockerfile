# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --only=production

# --- Production Stage ---
FROM node:20-alpine
WORKDIR /app

# Copy frontend files
COPY index.html ./
COPY css ./css
COPY js ./js
COPY assets ./assets

# Copy backend
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server/src/index.js"]
