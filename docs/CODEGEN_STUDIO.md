# Flap Vault Gen — User Guide

**Flap Vault Gen** lets anyone launch a custom vault on Flap without writing Solidity. Describe the mechanic in plain English, review the generated code and audit results, and launch directly from the website.

There is **no menu of vault types**. Any mechanic that fits Flap Rules 001–009 can be built.

---

## Getting started

1. Open the site and connect your MetaMask wallet.
2. You'll be asked to sign one short message — this proves you own the wallet (no transaction, no gas).
3. Describe your vault idea in the prompt box and click **Generate Solidity**.

---

## What runs when you click Generate

1. **Classify** — AI identifies the vault kind (staking, lottery, buyback, survivor, etc.) and checks whether it fits Flap rules.
2. **Scope verdict** — Before codegen, the studio decides whether your idea is launch-ready, draft-only, or unsupported (see verdicts below).
3. **Mechanic design** — For novel mechanics (milestone unlocks, register+claim, multi-phase), AI produces a lifecycle plan before writing code.
4. **Draft** — AI writes a full vault inheriting `CodegenVaultBase` with Flap V2 helpers.
5. **Compile** — Foundry `forge build` with solc 0.8.26 against real Flap interfaces.
6. **Dual safety scan** — Static blockers + mechanic completeness + economic payout scanners.
7. **Fix loop** — Up to 12 retries with structured failure memory if compile or scanners fail.
8. **Integration test** — Mainnet-fork Foundry test (Rule 006).
9. **Advisory audit** — 9-rule Flap spec review + economic critic (payout fairness). These never block deploy — they're for your review.
10. **Chat refine** — Follow-up messages update the same vault through the same loop.

---

## Scope verdicts

| Verdict | Meaning |
|---------|---------|
| **launch_ready_possible** | Fits Flap as described — codegen proceeds |
| **draft_only** | Useful spec, but not launch-ready as requested |
| **needs_custom_ui** | Needs custom frontend beyond Flap's standard panel |
| **needs_protocol_extension** | Needs changes to the Flap protocol itself |
| **unsafe_or_unsupported** | Refused — no contract generated |

If you consent to **closest draft**, the studio lists what was preserved, dropped, and what would be needed for your original request.

---

## The 9 Flap spec rules (pre-audit)

| Rule | What it checks |
|------|----------------|
| **001** | Tax buckets, fund flow, manager vs holder actions |
| **002** | `CodegenVaultFactory` / deployment compatibility |
| **003** | Gameable mechanics, pro-rata vs balance snapshots |
| **004** | Bilingual `require` messages for Flap.sh UI |
| **005** | No swaps, loops, or payouts inside `receive()` |
| **006** | Mainnet-fork Foundry coverage exists |
| **007** | Random outcomes via Flap AI Provider (not `block.prevrandao`) |
| **008** | Scheduled/keeper actions via Flap Trigger Service where needed |
| **009** | Emergency override + emergency withdraw patterns |

---

## Launching a token

After the vault passes the deploy-ready gate (compile + safety + fork tests), the **Launch on Flap** panel appears.

### What you fill in

| Field | Required | Notes |
|-------|----------|-------|
| Token name | Yes | |
| Token symbol | Yes | |
| Token image | Recommended | Shown on Flap.sh and the tokens gallery |
| Description | Recommended | Shown on Flap.sh |
| Website / X / Telegram | Optional | Social links shown on Flap.sh |
| Dev buy (BNB) | Optional | Amount of BNB you buy at launch |

### Three steps (all from the UI — no command line)

1. **Deploy factory** — Deploys your `CodegenVaultFactory` instance on-chain via MetaMask.
2. **Register vault** — Writes your vault's creation bytecode to the factory.
3. **Launch token** — Calls `newTokenV6WithVault` on Flap's VaultPortal; uploads metadata to IPFS via Flap's API; issues the token + attaches the vault in one transaction.

The launch URL (e.g. `https://testnet.flap.sh/tax/0x…`) is saved to your account and appears on the **Tokens** page.

---

## Tokens page (`/tokens`)

The public tokens gallery shows all vaults launched through Flap Vault Gen. Each entry displays:
- Token image, name, symbol
- Vault type and live BNB raised
- Tax rates
- Link to Flap.sh

Click any token to open its detail page, which includes a live vault UI (read and write methods pulled directly from the vault's `vaultUISchema()` on-chain).

---

## Chat history

Every vault generation and refinement is saved to your wallet's chat history (requires a connected wallet). Click **Chats** in the header to see all your previous vault conversations and pick up where you left off.

Anonymous chats (started without a wallet) are automatically claimed to your wallet when you connect.

---

## Language support

The studio supports **English** and **Simplified Chinese** (中文). Use the language toggle in the header. When you switch language, the AI mirrors it — generated vault `require` messages, error strings, and comments will also be in the selected language (Flap Rule 004 requires bilingual messages, so both are always included in the Solidity output).

---

## Writing better prompts

**Do:** name your tax buckets, specify holder vs manager actions, describe timing (weekly, per-epoch), mention if you need a lottery/oracle draw, account for per-user balances when designing multi-user payouts.

**Avoid:** balance-based payouts (snapshot instead), buyback logic inside `receive()`, on-chain holder enumeration, register+claim mechanics without a defined credit source.

---

## Lotteries and random winners

Flap uses the **Flap AI Provider** (VRF-style oracle). Entrants are snapshotted before the draw; the manager calls `requestDraw()`; an async callback pays the winner. The AI knows this — just say "secure random draw" or "lottery" in your prompt.

---

## Custom vault UI

When the AI generates a vault, it also produces a React UI component package matching Flap's Artifact Workbench format. This custom UI is:
- Rendered immediately on the token detail page inside a sandboxed iframe.
- Downloadable as a zip from the chat for Workbench submission to Flap.

Before Flap verifies and publishes the vault, the standard vault panel (derived from `vaultUISchema()`) is shown. After verification, Flap applies your custom UI on flap.sh too.

---

## Deploy ready vs mainnet ready

**Deploy ready** = compile + blocking scanners pass + fork tests pass. Read the generated code yourself, test on BSC testnet, and get an independent audit before deploying to mainnet with meaningful TVL.

---

## Self-hosting

Copy `server/.env.example` to `server/.env.local`, set `OPENAI_API_KEY`, then from the `web/` folder run:

```bash
npm run dev:all
```

Open http://localhost:5173. The API runs at http://localhost:3002.

For persistent chat history, also set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `server/.env.local` and apply `supabase/schema.sql` to your Supabase project. Without them, chat history is in-memory and lost on server restart.
