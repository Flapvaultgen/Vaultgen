# FlapVaultGen API — Node + Foundry (forge compile for codegen pipeline)
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Foundry (forge, cast, …)
ENV FOUNDRY_DIR=/root/.foundry
ENV PATH="${FOUNDRY_DIR}/bin:${PATH}"
RUN curl -L https://foundry.paradigm.xyz | bash \
  && foundryup

WORKDIR /app

# Solidity compile tree
COPY foundry.toml foundry.lock remappings.txt ./
COPY lib ./lib
COPY src ./src

# API server
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci

COPY server ./

WORKDIR /app

ENV NODE_ENV=production
EXPOSE 3002

CMD ["npm", "start", "--prefix", "server"]
