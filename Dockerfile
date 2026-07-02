FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build \
 && npx esbuild server/src/index.ts --bundle --platform=node --format=esm \
    --outfile=server-dist/index.mjs --external:bufferutil --external:utf-8-validate \
    --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/public
COPY --from=build /app/client/dist ./public
COPY --from=build /app/server-dist/index.mjs ./index.mjs
EXPOSE 8080
USER node
CMD ["node", "index.mjs"]
