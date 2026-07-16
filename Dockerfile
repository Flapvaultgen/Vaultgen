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
# test/ is required at runtime, not just for `forge test` in CI: the codegen pipeline writes
# each generated vault's fork test into test/_codegen/ and runs it against test/FlapBSCFixture.sol.
# Without this, every generation's integration-test step fails identically (missing import),
# and the pipeline burns its whole attempt budget rewriting a contract that was never the problem.
COPY test ./test

# API server
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci

COPY server ./

WORKDIR /app

ENV NODE_ENV=production
EXPOSE 3002

CMD ["npm", "start", "--prefix", "server"]
