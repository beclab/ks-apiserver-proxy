FROM node:26.12.1-trixie-slim AS server_dist

WORKDIR /server_dist

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
COPY server ./server
RUN npm run build

FROM node:26.12.1-trixie-slim

EXPOSE 8000

WORKDIR /server
COPY --from=server_dist /server_dist/dist/ ./

WORKDIR /server/main
CMD ["node", "server.js"]
