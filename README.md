# ks-apiserver-proxy
> Forwarding in relation to the ks-apiserver service and the integration of specific business logics. It provides services to Control Hub and Dashboard.

## Build and run

Use Node.js 26.12.1 (`nvm use`) and npm 11.20.0 or later.

```sh
npm ci
npm run build
node dist/main/server.js
```

The Docker build uses Node.js 26.12.1 for both build and runtime stages.
Dependencies are installed from `package-lock.json` with `npm ci`.
