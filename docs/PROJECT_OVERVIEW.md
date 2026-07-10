# Flap Vault Gen — Project Overview

Flap Vault Gen is an AI-powered platform that lets anyone launch a custom vault on [Flap](https://flap.sh) without writing Solidity. Describe your vault mechanic in plain English, review the generated contract and audit results, and launch directly from the web UI.

---

## What it does

| Step | What happens |
|------|-------------|
| **Describe** | User types a plain-English vault idea in the studio prompt |
| **Classify** | AI identifies the vault kind and checks if it fits Flap's rules before generating any code |
| **Generate** | Anthropic Claude writes a complete Solidity vault inheriting `CodegenVaultBase` (Flap V2) |
| **Compile** | Foundry `forge build` with solc 0.8.26 against real Flap interfaces |
| **Scan** | Dual safety scan — static fund-flow rules + mechanic completeness + economic payout checks |
| **Fix loop** | Up to 12 AI-driven retries if compile or scanners fail, with structured failure memory |
| **Test** | Mainnet-fork Foundry integration test (Flap Rule 006) |
| **Audit** | Advisory 9-rule Flap spec review + economic critic — never block deploy, shown for review |
| **Launch** | 3-step on-chain launch from the UI: deploy factory → register bytecode → launch token on Flap |
| **Persist** | Token record saved; appears on the public `/tokens` gallery |

---

## Architecture

```
web/               React studio UI (Vite + Tailwind)
  src/
    CodegenStudio.tsx       — prompt, stream, chat, scope banner
    ChatPage.tsx            — full chat history, code panel, launch panel
    TokensPage.tsx          — public launched-tokens gallery
    TokenDetailPage.tsx     — token + live vault stats + vault UI
    lib/
      flap-launch.ts        — newTokenV6WithVault call, preflight, revert decoding
      flap-register.ts      — registerVault call
      vault-state.ts        — on-chain vault reads (BNB raised, stats)
      chat-api.ts           — API client (auth headers on every call)
      current-user.ts       — wallet identity + session token cache
      i18n/                 — English + Simplified Chinese translations

server/            Node.js AI pipeline + HTTP API (tsx / ESM)
  codegen.ts              — main pipeline, system prompt, PREAMBLE, scanners
  vault-plan.ts           — vault kind classification + mechanic lifecycle design
  vault-scope.ts          — scope verdict (launch_ready / draft_only / out_of_scope)
  mechanic-completeness.ts — structural UI/mechanic scanners
  test-gen.ts             — AI-generated fork integration tests
  spec-audit.ts           — advisory 9-rule Flap spec audit
  economic-critic.ts      — advisory payout fairness review
  ui-gen.ts               — AI-generated React vault UI component package
  chat-store.ts           — Supabase-backed persistence (in-memory fallback)
  chat-routes.ts          — HTTP API routes (chat, run, artifact, launched-token)
  auth.ts                 — wallet signature auth (nonce + sign + HMAC session token)
  ai-client.ts            — Anthropic SDK client with prompt caching + token tracking
  ai-model.ts             — env-driven model resolution

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

### Scope verdicts

Before any code is generated, the studio classifies whether the idea fits Flap's runtime:

| Verdict | Meaning |
|---------|---------|
| `launch_ready_possible` | Fits Flap Tax Vault V2 — proceeds to codegen |
| `draft_only` | Valid mechanic but not launch-ready as described |
| `needs_custom_ui` | Mechanic works; requires a custom frontend for full UX |
| `needs_protocol_extension` | Requires changes to the Flap protocol |
| `unsafe_or_unsupported` | Refused — no contract generated |

### What Flap Vault Gen supports

**Works end-to-end:**
- Staking / earn: holders stake and earn pro-rata BNB from the tax pool
- Buyback-and-burn: manager calls buyback using accumulated tax BNB via Flap Portal
- Lottery / survivor: secure random draw via Flap AI Provider (VRF-style oracle)
- Treasury / milestone: manager-controlled releases and conditional payouts
- Registration + epoch + claim: novel lifecycle mechanics designed before codegen
- Any `hybrid` mix of the above

**Out of scope (different on-chain runtime):**
- Dual-token systems (vault minting a second token)
- Own AMM / bonding curve (users mint/sell at an internal price curve)
- NFT mints funded by tax
- Trustless off-chain data without Flap's oracle

### The 9 Flap spec rules

| Rule | What it checks |
|------|----------------|
| 001 | Tax buckets, fund flow, manager vs holder actions |
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
| Chat refine | Follow-up messages re-run the full pipeline on the same vault |
| Wallet sign-in | MetaMask signature proves wallet ownership — no transaction, no gas |
| Chat history | Persisted per wallet in Supabase; in-memory fallback for local dev |
| i18n | Full English + Simplified Chinese UI; AI vault code mirrors user's language |
| Token metadata | Image, description, website, X, Telegram uploaded to Flap IPFS at launch |
| Dev buy | Optional BNB amount bought by the deployer at launch (`quoteAmt`) |
| Tokens gallery | `/tokens` — public list with live on-chain vault stats |
| Custom vault UI | AI generates a React component package rendered in a sandboxed iframe |
| EIP-170 guard | Bytecode size check before launch; `--via-ir` rescue path for large contracts |
| Cost tracking | Per-run token usage and estimated USD cost logged for every AI call |

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
| Chain | BSC Testnet (97) + BSC Mainnet (56) · Robinhood Chain planned |

---

## Launch flow

The studio handles the full 3-step launch from the UI — no command line needed:

1. **Deploy factory** — deploys the user's `CodegenVaultFactory` instance on-chain
2. **Register vault** — writes creation bytecode to the factory so Flap shows the real description
3. **Launch token** — uploads token image + metadata to Flap IPFS, then calls `newTokenV6WithVault` on Flap's VaultPortal in one MetaMask transaction

After launch, the token record is saved and appears on `/tokens`.

---

## Security

- All chat and launch API routes require a wallet session token in the `Authorization` header
- Session tokens are stateless HMAC-signed (signed by `AUTH_SECRET`), 7-day expiry
- Users can only read and modify their own chats — server enforces ownership on every route
- `POST /api/launched-tokens` validates that all URLs are HTTPS before persisting

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (`sk-ant-…`) |
| `AI_MODEL` | Yes | Primary model — e.g. `claude-sonnet-5` |
| `AI_CHEAP_MODEL` | Recommended | Cheap model for advisory calls — e.g. `claude-haiku-4-5` |
| `AI_ESCALATION_MODEL` | Optional | Stronger model for final repair escalation |
| `AUTH_SECRET` | Yes (prod) | Signs session tokens — `openssl rand -hex 32` |
| `CORS_ORIGIN` | Yes (prod) | Vercel frontend URL |
| `SUPABASE_URL` | Recommended | Chat + token persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended | Server-side only — never sent to frontend |

---

## Local development

```bash
# Install deps
cd web && npm install
cd ../server && npm install

# Configure
cp server/.env.example server/.env.local
# edit: set ANTHROPIC_API_KEY (Anthropic key)

# Run everything
cd ../web && npm run dev:all
# UI  → http://localhost:5173
# API → http://localhost:3002
```

Connect MetaMask when the page loads — you'll sign one message to prove wallet ownership (no gas). The session is cached so subsequent loads don't re-prompt.

---

## Roadmap

| Priority | Item |
|----------|------|
| 1 | Robinhood Chain support (chain ID 4663) — Flap is live there |
| 2 | Archetype #2: bonding-curve vault (new base contract + custom UI track) |
| 3 | Plan approval step — show mechanic spec before codegen starts |
| 4 | Fork simulation preview — show user journeys run before launch |
