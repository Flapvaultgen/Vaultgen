# Flap Vault Gen — Project Overview

Flap Vault Gen is an AI-powered platform that lets anyone launch a custom vault on [Flap](https://flap.sh) without writing Solidity. Describe your vault mechanic in plain English or Simplified Chinese, approve the plan, review the generated contract and audit results, set your own buy/sell tax, and launch from the web UI.

---

## What it does

| Step | What happens |
|------|-------------|
| **Describe** | User types a plain-language vault idea (English or 中文) |
| **Plan** | AI writes a MechanicSpec (actors, buckets, actions, payouts) — no fixed vault-type menu |
| **Approve** | Generation pauses so the user can review the plan before any Solidity is written |
| **Scope** | Launch-readiness verdict (`launch_ready_possible` / draft / custom UI / protocol / unsafe) |
| **Generate** | Anthropic Claude writes a Solidity vault inheriting `CodegenVaultBase` (Flap V2) |
| **Compile** | Foundry `forge build` with solc 0.8.26 against real Flap interfaces |
| **Scan** | Safety scanners + mechanic completeness + ledger solvency (bucket vs claimable arithmetic) |
| **Fix loop** | Bounded AI retries; escalates to surgical fixes; abandons non-converging rule/test loops |
| **Test** | Mainnet-fork Foundry integration test (Flap Rule 006) with journey preview in the UI |
| **Audit** | Advisory Flap spec review + economic critic (stronger model when the vault owes pooled BNB) |
| **Launch** | Deploy factory → register bytecode → launch token; user sets buy/sell tax % and optional metadata / dev buy |
| **Persist** | Token record saved; appears on the public `/tokens` gallery and links to Flap at `/bnb-testnet/<address>` |

---

## Architecture

```
web/               React studio UI (Vite + Tailwind)
  src/
    CodegenStudio.tsx       — landing composer, stream, scope / plan cards
    ChatPage.tsx            — chat history, code panel, milestones, launch panel
    TokensPage.tsx          — public launched-tokens gallery
    TokenDetailPage.tsx     — token + live vault stats + vault UI
    DocsPage.tsx            — in-app documentation (EN / 中文)
    lib/
      flap-launch.ts        — newTokenV6WithVault call, preflight, revert decoding
      flap-register.ts      — registerVault call
      launch-validation.ts  — tax % → bps, payload checks, revert decoding
      studio-config.ts      — Flap token URLs (/bnb-testnet or /bnb), factory cache
      chat-api.ts           — API client (auth headers on every call)
      i18n/                 — English + Simplified Chinese translations

server/            Node.js AI pipeline + HTTP API (tsx / ESM)
  codegen.ts              — pipeline orchestrator + safety scanners
  codegen-prompts.ts      — system prompts + injected PREAMBLE base contract
  mechanic-spec.ts        — MechanicSpec planner (authoritative product plan)
  prompt-language.ts      — detect EN vs ZH from the prompt; force plan copy language
  vault-scope.ts          — scope verdict (launch_ready / draft_only / …)
  mechanic-completeness.ts — structural UI/mechanic scanners
  money-flow.ts           — money-variable ledger: blocking solvency rule + critic evidence
  test-gen.ts             — AI-generated fork integration tests
  spec-audit.ts           — advisory 9-rule Flap spec audit
  economic-critic.ts      — advisory payout fairness review
  fixtures/               — real generated vaults kept as regression corpus
  ui-gen.ts               — AI-generated React vault UI component package
  chat-store.ts           — Supabase-backed persistence (in-memory fallback)
  chat-routes.ts          — HTTP API routes (chat, run, artifact, launched-token)
  auth.ts                 — wallet signature auth (nonce + sign + HMAC session token)
  ai-client.ts            — Anthropic SDK client with prompt caching + token tracking
  ai-model.ts             — env-driven model resolution
  run-timing.ts           — per-pass phase timings for the run summary in the logs

src/               Solidity contracts
  CodegenVaultFactory.sol — on-chain bytecode registry (CREATE2 launch)
  flap/                   — Flap V2 protocol interfaces + base contracts

test/              Foundry tests
  CodegenVaultFactory.t.sol
  _codegen/               — AI-generated mainnet fork tests per vault

supabase/
  schema.sql              — full DB schema (users, chats, runs, artifacts, launched_tokens)
  migrations/             — versioned migration files
```

---

## AI pipeline detail

### Prompt language

Before planning or classifying, the server counts Han vs Latin letters in the user's prompt (`prompt-language.ts`) and injects an explicit `OUTPUT LANGUAGE: English` or `Simplified Chinese` into the planner and scope classifier. Free-text fields on the plan card follow that language; schema keys and `contractName` stay English.

### Scope verdicts

| Verdict | Meaning |
|---------|---------|
| `launch_ready_possible` | Fits Flap Tax Vault V2 — proceeds after plan approval |
| `draft_only` | Valid mechanic but not launch-ready as described |
| `needs_custom_ui` | Mechanic works; needs a custom frontend for full UX |
| `needs_protocol_extension` | Requires changes to the Flap protocol |
| `unsafe_or_unsupported` | Refused — no contract generated |

### What Flap Vault Gen supports

There is **no fixed menu of vault types**. The generator is archetype-free: any fee/reward mechanic that fits Flap Rules 001–009 can be planned and built (staking, buybacks, lotteries, votes, quests, referrals, epochs, hybrids, …).

**Out of scope (different on-chain runtime):**
- Dual-token systems (vault minting a second token)
- Own AMM / bonding curve
- NFT mints funded by tax
- Trustless off-chain data without Flap's oracle

### The 9 Flap spec rules

| Rule | What it checks |
|------|----------------|
| 001 | Tax buckets, fund flow, manager vs holder actions, solvency |
| 002 | `CodegenVaultFactory` / deployment compatibility |
| 003 | Gameable mechanics, pro-rata vs balance snapshots |
| 004 | Bilingual `require` messages (EN + ZH) for Flap.sh UI |
| 005 | No swaps, loops, or payouts inside `receive()` |
| 006 | Mainnet-fork Foundry coverage exists |
| 007 | Random outcomes via Flap AI Provider — not `block.prevrandao` |
| 008 | Scheduled/keeper actions via Flap Trigger Service |
| 009 | Emergency override + emergency withdraw patterns |

---

## Key features

| Feature | Notes |
|---------|-------|
| Plan approval | Clean launch-ready ideas pause with a reviewable MechanicSpec before Solidity |
| Chat refine | Follow-up messages re-run the pipeline on the same vault |
| Wallet sign-in | MetaMask signature proves ownership — no transaction, no gas |
| Configurable tax | Launch form: buy % and sell % (1%–10%, Flap limit: 100–1000 bps); default 5% / 5% |
| Flap token URL | Testnet: `https://testnet.flap.sh/bnb-testnet/<address>` · Mainnet: `https://flap.sh/bnb/<address>` |
| Prompt language | Plan / scope free-text matches EN or 中文 from the prompt (not the site toggle alone) |
| i18n | Full English + Simplified Chinese UI |
| Token metadata | Image, description, website, X, Telegram uploaded to Flap IPFS at launch |
| Dev buy | Optional BNB bought by the deployer at launch (`quoteAmt`) |
| Tokens gallery | `/tokens` — public list with live on-chain vault stats |
| Custom vault UI | AI-generated React package in a sandboxed iframe; Workbench for flap.sh binding |
| Ledger solvency | Deterministic money-flow table; blocks crediting claimables without tracking liability |
| Pass budget | Surgical escalate on repeated rules; abandon stalled rule/test loops early |
| Run timing | Per-pass phase timings in server logs |
| EIP-170 guard | Bytecode size check; `--via-ir` rescue for large contracts |
| Cost tracking | Per-run token usage and estimated USD cost |

---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + Tailwind CSS + wagmi/viem |
| Backend | Node.js (tsx / ESM) + Hono HTTP |
| AI | Anthropic Claude (native SDK, prompt caching enabled) |
| Solidity toolchain | Foundry (forge build, forge test) · solc 0.8.26 |
| Database | Supabase (PostgreSQL) — optional; in-memory fallback |
| Auth | SIWE-lite: nonce → MetaMask sign → HMAC session token |
| Chain | BSC Testnet (97) + BSC Mainnet (56) — launch UI is BSC-only |

---

## Launch flow

1. **Deploy factory** — deploys the user's `CodegenVaultFactory` on-chain  
2. **Register vault** — writes creation bytecode so Flap shows the real description  
3. **Launch token** — set name, symbol, **buy/sell tax %**, optional image/links/dev buy → Flap IPFS + `newTokenV6WithVault`

Tax rates are chosen in the studio launch panel (percent inputs) and converted to basis points for the portal. They cannot be changed after launch.

After launch, the token appears on `/tokens` and the Flap link uses `/bnb-testnet/<address>` (testnet) or `/bnb/<address>` (mainnet).

---

## Security

- Chat and launch API routes require a wallet session token in `Authorization`
- Session tokens are stateless HMAC-signed (`AUTH_SECRET`), 7-day expiry
- Users can only read/modify their own chats
- `POST /api/launched-tokens` validates HTTPS URLs before persisting

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (`sk-ant-…`) |
| `AI_MODEL` | Yes | Primary model — e.g. `claude-sonnet-5` |
| `AI_CHEAP_MODEL` | Recommended | Cheap model for advisory calls |
| `AI_ESCALATION_MODEL` | Optional | Stronger model for critic / repair escalation |
| `AUTH_SECRET` | Yes (prod) | Signs session tokens — `openssl rand -hex 32` |
| `CORS_ORIGIN` | Yes (prod) | Vercel frontend URL |
| `SUPABASE_URL` | Recommended | Chat + token persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended | Server-side only — never sent to frontend |

---

## Local development

```bash
cd web && npm install
cd ../server && npm install

cp server/.env.example server/.env.local
# edit: set ANTHROPIC_API_KEY

cd ../web && npm run dev:all
# UI  → http://localhost:5173
# API → http://localhost:3002
```

Connect MetaMask and sign once to prove wallet ownership (no gas). The session is cached.

---

## Roadmap

Shipped:
- **Plan approval gate** — review MechanicSpec before Solidity  
- **Fork simulation preview** — Review tab shows fork-test journeys  

Nothing else queued. Robinhood Chain is parked; launch stays BSC-only.
