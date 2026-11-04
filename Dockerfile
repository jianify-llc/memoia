FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app/src/worker
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY src/worker/package.json src/worker/pnpm-lock.yaml ./
COPY src/worker/vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY src/worker/ ./
COPY sdks/typescript/src/generated /app/sdks/typescript/src/generated
RUN pnpm build:node && pnpm prune --prod

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node LICENSE NOTICE /app/
COPY --from=build --chown=node:node /app/src/worker/package.json /app/package.json
COPY --from=build --chown=node:node /app/src/worker/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/src/worker/dist-node /app/dist-node
USER node
EXPOSE 8080
CMD ["node", "dist-node/node-api.js"]
