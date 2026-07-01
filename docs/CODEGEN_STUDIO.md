# Flap Vault Gen — User Guide

**Flap Vault Gen is v0 for tax vaults.**

Launching a custom vault on Flap normally requires Solidity expertise, Flap Rules 001–009, and avoiding EVM footguns. **Flap Vault Gen** automates the front half: describe the mechanic in plain English, get a **MechanicSpec** plan, a **scope verdict**, generated Solidity, Foundry compile, deterministic safety scanners, fork tests, and an advisory 9-rule pre-audit — then refine in chat.

There is **no menu of vault types**. Any mechanic that fits Flap Rules 001–009 can be built. Output deploys through **`CodegenVaultFactory`**. Testnet first. Mainnet still needs human review and a third-party audit.

---

## What runs when you click Generate

1. **Mechanic plan** — AI outputs a `MechanicSpec` JSON (actors, buckets, actions, payout rules, applicable Flap rules). Regex fallback if no API key.
2. **Scope verdict** — Before codegen: `launch_ready_possible`, `draft_only`, `needs_custom_ui`, `needs_protocol_extension`, or `unsafe_or_unsupported`. Non-launch verdicts require explicit consent.
3. **Draft** — AI writes a full vault inheriting `CodegenVaultBase` with Flap V2 helpers.
4. **Compile** — Foundry `forge build` with solc 0.8.26 against real Flap interfaces.
5. **Dual safety scan** — Static blockers + mechanic completeness + **economic payout scanners** (e.g. first claimer draining shared pools).
6. **Fix loop** — Up to 12 retries with structured failure memory.
7. **Integration test** — Mainnet-fork Foundry test (Rule 006); skipped when `SKIP_FORK_TESTS=1` or no RPC.
8. **Flap pre-audit (advisory)** — 9-rule LLM review; FAIL items downgraded to warnings — do not alone block deploy.
9. **Economic critic (advisory)** — Optional GPT payout fairness review after scanners pass.
10. **Chat refine** — Follow-up messages run the same loop on your existing vault.

---

## Scope verdicts

| Verdict | Meaning |
|---------|---------|
| **launch_ready_possible** | Fits Flap as described — codegen proceeds |
| **draft_only** | Useful spec, not launch-ready as requested |
| **needs_custom_ui** | Needs custom frontend beyond Flap.sh UI |
| **needs_protocol_extension** | Needs Flap protocol changes |
| **unsafe_or_unsupported** | Refused — no contract generated |

If you consent to **closest draft**, the studio lists what was preserved, dropped, and required for the original request.

---

## The 9 Flap spec rules (pre-audit)

| Rule | What it checks |
|------|----------------|
| **001** Vault rules | Tax buckets, fund flow, manager vs holder actions |
| **002** Factory rules | `CodegenVaultFactory` / deployment compatibility |
| **003** Fairness | Gameable mechanics, pro-rata vs balance snapshots |
| **004** UI-friendly | Bilingual `require` messages for Flap.sh UI |
| **005** Receive gas limit | No swaps, loops, or payouts inside `receive()` |
| **006** Integration tests | Mainnet-fork Foundry coverage exists |
| **007** AI oracle | Random outcomes via Flap AI Provider |
| **008** Trigger service | Scheduled / keeper actions where needed |
| **009** Emergency controls | Override + emergency withdraw patterns |

---

## Create a vault in three steps

### 1. Describe the mechanic

Use the hero prompt. Name tax buckets, user actions, timing, and random winners if needed.

**Examples:**
- *Stake-to-earn: holders stake and earn pro-rata tax BNB. stake, unstake, claimReward.*
- *Buyback vault: split tax 50/50 buyback + treasury. Manager runs buyback.*
- *Weekly burn lottery: buyback + jackpot buckets. Holders enter once per round. Secure random draw.*
- *Quest proof vault: users submit proofs, manager approves, approved users claim from reward bucket.*

### 2. Review the result

| Panel | What it means |
|-------|----------------|
| **Compiled** | Solidity built with Foundry + Flap interfaces |
| **Safety** | pass / review / blocked |
| **Scope** | Launch-ready vs draft-only |
| **Flap pre-audit** | Advisory — does not alone block deploy |
| **Deploy ready** | Compile + safety pass + fork tests |

### 3. Refine in chat

After first generation, chat mode opens. Each message updates the same vault. **New vault** starts fresh.

---

## Writing better prompts

**Do:** named buckets, holder vs manager actions, lottery/oracle when needed, per-user payout accounting for multi-user rewards.

**Avoid:** balance-based payouts, buyback in `receive()`, on-chain holder enumeration, register+claim without credit source.

---

## Lotteries and random winners

Flap uses the **Flap AI Provider** (VRF-style oracle). Entrants snapshotted before draw; manager calls `requestDraw()`; async callback pays winner. Not `block.prevrandao`.

---

## Deploy ready vs mainnet ready

**Deploy ready** = compile + blocking scanners pass + fork tests (when RPC available). Read code yourself, test on BSC testnet, get independent audit for meaningful TVL.

Launch via **`CodegenVaultFactory`** on [Flap.sh](https://flap.sh).

---

## Self-hosting

Set `OPENAI_API_KEY` in `server/.env.local`, then from `web`: `npm run dev:all` → http://localhost:5173
