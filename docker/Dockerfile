FROM node:18.15.0-buster-slim as server_dist

WORKDIR /server_dist

COPY package*.json ./

RUN yarn

ADD ./ ./

RUN yarn add rimraf@5.0.7 -D && yarn build


FROM node:18.15.0-buster-slim

EXPOSE 8000

WORKDIR /server

COPY --from=server_dist /server_dist/dist/ ./

WORKDIR /server/main

CMD [ "node", "server.js"]
