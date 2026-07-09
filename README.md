# Flap Vault Gen

Launching a custom vault on Flap normally requires coding skills, knowledge of the 9 spec rules, and avoiding common EVM pitfalls. Flap Vault Gen removes that barrier.

Describe the mechanic in plain English. The platform generates Solidity using Flap's base contracts, compiles it with Foundry, runs static and behavioral checks, provides an advisory 9-rule Flap pre-audit — then lets you launch directly to Flap from the web UI.

**More creative vaults on Flap. Less broken code making it to review.**

---

## How it works

Each generation runs a closed loop until it passes or exhausts its retry budget:

| Step | What runs | Purpose |
|------|-----------|---------|
| **0. Classify** | `classifyVaultPlan()` | JSON vault kind + buckets + invariants before codegen |
| **0b. Mechanic design** | `expandMechanicDesign()` | Lifecycle contract for novel prompts (milestone, register+claim, …) |
| **1. Draft** | Anthropic Claude (model set by `OPENAI_MODEL`) | Writes a complete vault inheriting `CodegenVaultBase` / Flap V2 |
| **2. Compile** | Foundry (`forge build`, solc 0.8.26) | Real compile against Flap interfaces; compile errors feed back to AI |
| **3. Dual safety scan** | `scanSafetyCombined()` | Logic + mechanic completeness scanners |
| **4. Fix loop** | AI + structured failure memory | Retries compile / safety / fork test failures (up to 12 passes) |
| **5. Integration test** | Foundry + AI | Mainnet-fork test (Rule **006**); runs `forge test --fork-url` |
| **6. Advisory audit** | 9-rule spec corpus + economic critic | Flap spec review + payout fairness; never blocks deploy |
| **7. Refine in chat** | Same pipeline | Incremental edits re-run the full loop |

**Deploy-ready gate:** compile OK + safety scanners pass + integration tests pass. Pre-audit is advisory for human review.

**Deploy path:** compiled creation bytecode → `CodegenVaultFactory` (CREATE2) → Flap token launch on BSC testnet or mainnet.

**Stack:** React studio · Node API · Foundry · Anthropic Claude (OpenAI as fallback) · bundled `flap-spec-checker` rules · Flap V2 base contracts in `src/flap/`.

---

## What's in this repo

| Path | Purpose |
|------|---------|
| `web/` | Codegen Studio UI — prompt, chat, launch panel, tokens gallery |
| `server/` | AI pipeline, safety scanners, spec audit, chat/run persistence, wallet auth |
| `src/` | `CodegenVaultBase`, `CodegenVaultFactory`, Flap V2 interfaces |
| `src/flap/` | Flap V2 protocol interfaces (required for compile) |
| `test/` | Foundry unit + fork tests; `test/_codegen/` = generated-vault mainnet fork suite |
| `supabase/` | Database schema + migrations for chat/token history |
| `docs/` | User guide, project overview, spec audit reference |

---

## Feature overview

| Feature | Notes |
|---------|-------|
| Prompt → stream Solidity | Any mechanic that fits Flap Rules 001–009 |
| Chat refine | Follow-up messages update the same vault |
| Wallet sign-in | MetaMask signature proves wallet ownership; session token on all API calls |
| Chat history | Persisted per wallet in Supabase (in-memory fallback for local dev) |
| Launch on Flap | Deploy factory → register bytecode → launch token with metadata, image, dev buy |
| Tokens gallery | `/tokens` — public list of launched tokens with vault stats |
| Custom vault UI | AI generates a React component package; rendered in a sandboxed iframe |
| English + 中文 | Full i18n; AI-generated vault code mirrors the user's language |
| Advisory pre-audit | 9-rule Flap spec review + economic critic (advisory — never blocks deploy) |

---

## Local development

```bash
# Install deps
cd web && npm install
cd ../server && npm install

# API keys (server)
cp server/.env.example server/.env.local
# Edit server/.env.local — at minimum set OPENAI_API_KEY

# Run UI + API together
cd ../web && npm run dev:all
```

- UI: http://localhost:5173
- API: http://localhost:3002 (`/api/health`)

Connect MetaMask when prompted — you'll sign one message to prove wallet ownership (no gas, no transaction). The session is cached, so subsequent loads don't re-prompt.

---

## Production deploy (split)

| Service | Host | Root |
|---------|------|------|
| Frontend | **Vercel** | `web/` |
| Backend | **Railway** | repo root (needs Foundry + full `src/`) |

**Vercel env:** `VITE_API_URL=https://your-railway-service.up.railway.app`

**Railway env:**

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes | Your Anthropic key (`sk-ant-…`); the OpenAI-compatible endpoint is used internally |
| `OPENAI_BASE_URL` | Yes | Set to `https://api.anthropic.com/v1/` to route to Anthropic. Unset = OpenAI (fallback only) |
| `OPENAI_MODEL` | Yes | Primary model — e.g. `claude-sonnet-5` for codegen, planning, and repair |
| `OPENAI_CHEAP_MODEL` | Recommended | Cheaper model for advisory calls (scope, economic critic) — e.g. `claude-haiku-4-5` |
| `OPENAI_ESCALATION_MODEL` | Optional | Stronger model for one final repair escalation attempt |
| `AUTH_SECRET` | **Yes in prod** | Signs wallet session tokens — use `openssl rand -hex 32`; unset = random per-process (sessions reset on restart) |
| `CORS_ORIGIN` | Yes | Your Vercel URL, e.g. `https://flapvaultgen.vercel.app` |
| `SUPABASE_URL` | Recommended | Chat/token history persistence; in-memory fallback if unset |
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended | Server-side only — never exposed to the frontend |

Apply `supabase/schema.sql` to your Supabase project before setting the Supabase env vars.

See `railway.toml` and `web/vercel.json`.

---

## Verify / test

```bash
# Server selfchecks (safety, scanners, mechanic completeness, wallet auth, chat store)
cd server && npm run test:scanners

# Web selfchecks (validation, vault UI bridge, i18n)
cd web && npm test

# Live codegen trial (generates 3 vaults — needs OPENAI_API_KEY)
cd server && npx tsx verify-codegen.mts
```

Solidity tests (requires Foundry):

```bash
forge test                              # unit tests only
forge test --fork-url <BSC_RPC_URL>    # includes mainnet-fork integration tests
```

---

## Chain support

| Chain | Status |
|-------|--------|
| BSC Testnet (97) | ✅ Fully supported — default for testnet launches |
| BSC Mainnet (56) | ✅ Supported |
| Robinhood Chain (4663) | 🔜 Flap is live there — multi-chain support is the next planned feature |

---

## License

MIT — see Flap protocol terms for on-chain deployment on Flap.sh.
