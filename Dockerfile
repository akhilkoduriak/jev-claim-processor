# syntax=docker/dockerfile:1

# 1. Build the React frontend
FROM node:24-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# 2. Runtime: the Express API also serves the built frontend
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=5000 \
    DATA_DIR=/app/data
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/ ./
COPY sample-claims.json /app/sample-claims.json
COPY --from=frontend /app/frontend/build /app/frontend/build
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:5000/health > /dev/null || exit 1
# Configure Jev with environment variables at run time, for example:
#   docker run -p 5000:5000 -e JEV_API_KEY=... -e JEV_API_URL=... -e JEV_API_PATH=... <image>
CMD ["node", "server.js"]
