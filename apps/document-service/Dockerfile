FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/extension/package.json apps/extension/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/document-service/package.json apps/document-service/package.json
COPY packages/translation-core/package.json packages/translation-core/package.json
COPY packages/assistant-core/package.json packages/assistant-core/package.json
COPY packages/document-contracts/package.json packages/document-contracts/package.json
COPY apps/pdf-cli/package.json apps/pdf-cli/package.json
COPY packages/document-renderer/package.json packages/document-renderer/package.json
COPY packages/web-capture/package.json packages/web-capture/package.json
COPY packages/document-bundle/package.json packages/document-bundle/package.json
RUN npm ci
COPY . .
RUN npm run build:site && npm prune --omit=dev

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/translation-core/package.json ./packages/translation-core/package.json
COPY --from=build /app/packages/translation-core/dist ./packages/translation-core/dist
COPY --from=build /app/packages/assistant-core/package.json ./packages/assistant-core/package.json
COPY --from=build /app/packages/assistant-core/dist ./packages/assistant-core/dist
COPY --from=build /app/packages/document-contracts/package.json ./packages/document-contracts/package.json
COPY --from=build /app/packages/document-contracts/dist ./packages/document-contracts/dist
COPY --from=build /app/packages/web-capture/package.json ./packages/web-capture/package.json
COPY --from=build /app/packages/web-capture/dist ./packages/web-capture/dist
COPY --from=build /app/packages/document-renderer/package.json ./packages/document-renderer/package.json
COPY --from=build /app/packages/document-renderer/dist ./packages/document-renderer/dist
COPY --from=build /app/packages/document-renderer/static ./packages/document-renderer/static
COPY --from=build /app/packages/document-renderer/compat ./packages/document-renderer/compat
COPY --from=build /app/packages/document-bundle/package.json ./packages/document-bundle/package.json
COPY --from=build /app/packages/document-bundle/dist ./packages/document-bundle/dist
COPY --from=build /app/apps/document-service/package.json ./apps/document-service/package.json
COPY --from=build /app/apps/document-service/dist ./apps/document-service/dist
COPY --from=build /app/apps/document-service/migrations ./apps/document-service/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Text inside saved SVG figures needs a font when it is rendered to PNG.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data/objects && chown -R node:node /data
USER node
EXPOSE 4320
CMD ["node", "apps/document-service/dist/main.js"]
