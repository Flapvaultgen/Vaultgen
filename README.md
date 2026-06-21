# Flap Vault Gen

**Flap Vault Gen is v0 for tax vaults.**

Right now, launching a custom vault on Flap requires a lot of coding skills. You need Solidity help. You need to understand the 9 spec rules. You need to avoid dumb EVM footguns like `receive()` gas limits and block randomness. And even after all that, there’s a decent chance an audit catches something obvious on day one.

**Flap Vault Gen fixes the front half.**

Describe the mechanic in plain English. It turns that into Solidity using Flap’s base contracts, compiles it with Foundry, catches compile and safety issues, runs the 9-rule Flap pre-audit, then lets you keep refining in chat.

This isn’t “AI wrote a contract.” It’s **AI, Foundry, Flap rule scanners, and the spec corpus running in one loop.**

The output deploys through **`CodegenVaultFactory`**. Testnet first. Mainnet still needs a real audit.

**More creative vaults on Flap. Less broken code making it to review.**

---

## How it works

Each generation runs the same closed loop until it passes or exhausts its retry budget:

| Step | What runs | Purpose |
|------|-----------|---------|
| **1. Draft** | OpenAI (`gpt-4.1`) | Writes a complete vault inheriting `CodegenVaultBase` / Flap V2 — not a template picker |
| **2. Compile** | **Foundry** (`forge build`, solc **0.8.26**) | Real compile against Flap interfaces in this repo; compile errors feed back to AI |
| **3. Safety scan** | Static scanners in `server/codegen.ts` | Blocks `receive()` swaps, block randomness, full-balance payouts, missing base overrides, etc. |
| **4. Logic scan** | `scanVaultLogic()` | Mechanic-specific checks (lottery snapshots, survivor elimination, staking accrual, oracle callbacks) |
| **5. Fix loop** | AI + scanners | Retries compile failures, safety blocks, and spec FAILs with targeted fix prompts |
| **6. Integration test** | Foundry + AI | Generates a mainnet-fork test scaffold (Flap Rule **006**) |
| **7. Flap pre-audit** | 9-rule spec corpus | AI verifier loads rules **001–009** (fund flow, factory, fairness, UI, receive gas, oracle, triggers, emergency) |
| **8. Refine in chat** | Same pipeline | Incremental edits re-run compile → safety → audit |

**Deploy path:** compiled creation bytecode → **`CodegenVaultFactory`** (CREATE2) → Flap token launch on testnet or mainnet.

**Stack:** React studio · Node API · Foundry · OpenAI · bundled `flap-spec-checker` rules · Flap V2 base contracts in `src/flap/`.

No fixed template menu. Each vault is generated for your prompt, then validated before you deploy.

---

## What's in this repo

| Path | Purpose |
|------|---------|
| `web/` | Codegen Studio UI (React + Vite) |
| `server/` | AI codegen API, safety pipeline, spec audit |
| `src/flap/` | Flap V2 protocol interfaces (required for compile) |
| `src/CodegenVaultFactory.sol` | On-chain factory for generated vault bytecode |
| `docs/CODEGEN_STUDIO.md` | User guide — prompts, lottery/oracle notes, deploy-ready |

---

## Local development

```bash
# Install deps
cd web && npm install
cd ../server && npm install

# API keys (server)
cp server/.env.example server/.env.local
# Edit server/.env.local — set OPENAI_API_KEY

# Run UI + API together
cd ../web && npm run dev:all
```

- UI: http://localhost:5173  
- API: http://localhost:3002 (`/api/health`)

---

## Production deploy (split)

| Service | Host | Root |
|---------|------|------|
| Frontend | **Vercel** | `web/` |
| Backend | **Railway** | repo root (needs Foundry + full `src/`) |

**Vercel env:** `VITE_API_URL=https://your-railway-service.up.railway.app`

**Railway env:** `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-4.1`, `CORS_ORIGIN=https://your-vercel-app.vercel.app`

See `railway.toml` and `web/vercel.json`.

---

## Verify / test

```bash
cd server && npm run test:scanners          # static safety scanner self-check
cd server && npx tsx verify-codegen.mts     # generate 3 vaults + logic review
```

Solidity tests (requires Foundry):

```bash
forge test
```

---

## License

MIT — see Flap protocol terms for on-chain deployment on Flap.sh.
