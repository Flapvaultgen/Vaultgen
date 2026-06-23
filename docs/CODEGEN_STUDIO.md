# Flap Vault Gen — User Guide

**Flap Vault Gen is v0 for tax vaults.**

Right now, launching a custom vault on Flap requires a lot of coding skills. You need Solidity help. You need to understand the 9 spec rules. You need to avoid dumb EVM footguns like `receive()` gas limits and block randomness. And even after all that, there’s a decent chance an audit catches something obvious on day one.

**Flap Vault Gen fixes the front half.**

Describe the mechanic in plain English. It turns that into Solidity using Flap’s base contracts, compiles it with Foundry, catches compile and safety issues, runs the 9-rule Flap pre-audit, then lets you keep refining in chat.

This isn’t “AI wrote a contract.” It’s **AI, Foundry, Flap rule scanners, and the spec corpus running in one loop.**

The output deploys through **`CodegenVaultFactory`**. Testnet first. Mainnet still needs a real audit.

---

## What runs when you click Generate

The studio is not a one-shot chat completion. Each pass runs this pipeline:

1. **Draft** — AI writes a full vault contract (inherits `CodegenVaultBase`, uses Flap V2 tax/oracle helpers).
2. **Compile** — **Foundry** runs `forge build` with **solc 0.8.26** against real Flap interfaces. Failures go back to AI with compiler output.
3. **Safety scan** — Static blockers: cheap `receive()`, no block randomness for winners, named buckets (not `address(this).balance`), no `selfdestruct` / `delegatecall`, required `description()` + `vaultUISchema()`, and more.
4. **Logic scan** — Mechanic-specific checks for lotteries, survivor games, staking accrual, oracle callbacks, etc.
5. **Fix loop** — If compile, safety, or spec checks fail, AI rewrites with a targeted fix prompt (you see pass count and reason in the progress panel).
6. **Integration test** — AI writes a **mainnet-fork Foundry test** scaffold (Flap Rule **006**).
7. **Flap pre-audit** — Verifier reads the **9 official spec rules** (001–009) and returns pass / warn / fail per rule.
8. **Chat refine** — Follow-up messages run the same loop on your existing vault.

When the panel shows **Deploy ready**, you have compiled bytecode that cleared automated checks — good for **testnet**. Mainnet still needs human review and a third-party audit.

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
| **007** AI oracle | Random outcomes via Flap AI Provider, not block entropy |
| **008** Trigger service | Scheduled / keeper actions where needed |
| **009** Emergency controls | Override + emergency withdraw patterns |

---

## Deploy paths

**Studio default (testnet):** non-upgradeable constructor vault → `CodegenVaultFactory` CREATE2 bytecode deploy. Rule 009 emergency withdraw is inherited from `CodegenVaultBase` (Guardian full-balance drain — disclosed in staking/lottery descriptions).

**Production (say "upgradeable" or "mainnet-ready" in your prompt):** generator switches to the FreeCoinBeacon pattern — `Initializable` vault + `UpgradeableBeacon` factory + `BeaconProxy`. No emergency drain functions on the vault; Guardian-only upgrades are the escape hatch.

---

## Create a vault in three steps

### 1. Describe the mechanic

In the text box, explain what should happen when tax BNB arrives and what holders can do.

**Good prompts name:**
- Where tax goes (buyback, jackpot, treasury, stakers, etc.)
- What users can call (`stake`, `enter`, `claim`, etc.)
- Any timing (weekly draw, 24h window, lock period)
- Whether you need a **random winner** or **survivor elimination** (see below)

**Examples you can paste:**

- *Stake-to-earn: holders stake the tax token and earn a pro-rata share of tax BNB. stake, unstake, claimReward.*
- *Buyback vault: split tax 50/50 into buyback budget and creator treasury. Manager runs buyback with slippage protection.*
- *Weekly burn lottery: tax fills buyback + jackpot. Holders enter once per round. Manager runs a secure random draw for the jackpot.*
- *Survivor: users stake to join. Each round one staker is eliminated at random until one winner takes the pool.*

Click **Generate**. The contract streams in on the right while the studio compiles and checks it.

### 2. Review the result

When generation finishes, you will see:

| Panel | What it means for you |
|-------|------------------------|
| **Compiled** | Solidity built successfully with the real Flap compiler |
| **Safety** | **pass** = no serious issues found · **review** = warnings worth reading · **blocked** = must fix before testnet |
| **Flap pre-audit** | Checked against Flap’s official vault rules (fund flow, fairness, UI compatibility, etc.) |
| **Deploy ready** | Green only when compile + safety + audit are all clear enough for testnet |

The timeline shows what the studio did for you — writing code, fixing compile errors, running checks — so you do not have to do that by hand.

### 3. Refine in chat

After the first generation, the view switches to **chat mode**. Keep the code panel open and ask for changes in normal language, for example:

- *Add a 7-day unstake lock*
- *Cap lottery entrants at 255*
- *Split tax 40% buyback, 40% charity wallet, 20% treasury*
- *Use pull-payment so winners claim their prize instead of auto-send*

Each message updates the same vault (it does not start from scratch unless you click **New vault**).

---

## Writing better prompts

**Do:**
- Say how tax BNB is **split into buckets** (buybackBudget, jackpot, treasury, …)
- Say who acts — **holders** vs **manager/creator**
- Mention **lottery / random / survivor** if you need a random pick (the studio uses Flap’s secure oracle)
- Mention **scheduled** actions if something should run on a timer (e.g. automated buyback every 6 hours)

**Avoid:**
- *“Pay everyone by current token balance”* — that is gameable; ask for **staking + rewards** instead
- *“Do the buyback inside receive()”* — tax arrives in `receive()`; buyback must be a separate manager action
- *“List all token holders on-chain”* — impossible; use a **keeper list** or **stake to participate**

---

## Lotteries, raffles, and random winners

If your vault picks a winner or eliminates a player at random, Flap uses the **Flap AI Provider** — an on-chain oracle (VRF-style: request → wait → verified callback). This is **not** `block.prevrandao` and not Chainlink on BSC.

**What you get:**
- Entrants are **snapshotted** before the draw so no one can join after the result is known
- The manager calls something like `requestDraw()` and pays a small oracle fee (usually from the jackpot)
- The oracle returns a random index; the vault pays the winner in `_fulfillReasoning`

**What to tell users in your token description:**
- Draws are async (not instant in the same button click)
- Randomness comes from the Flap AI oracle (small fee per draw)
- Manager still chooses **when** to start a draw unless you also ask for scheduled automation

For **survivor / elimination** games, the same oracle pattern applies — one random elimination per round until one staker remains.

---

## What the studio checks automatically

You do not need to memorize Flap’s spec. Behind the scenes the studio enforces common rules, including:

- Tax in `receive()` only updates **buckets** — no swaps or payouts there
- Payouts use **named buckets**, not “send entire contract balance”
- User-facing errors use **bilingual** `require` messages (English / 中文) for the Flap UI
- Lotteries cap entrants (gas safety) and reset entry flags between rounds
- Random outcomes use the **Flap AI oracle**, not block entropy
- Staking rewards use proper **accrual math**, not live wallet balance

If something fails, the studio **retries and fixes** on its own (compile errors, safety blocks, many audit issues) before showing you the result.

---

## Deploy ready vs mainnet ready

**Deploy ready (green in the studio)** means the vault **compiled** and passed automated safety + spec checks well enough for **testnet experiments**.

Before **mainnet** and real holder funds:

1. Read the generated code and the pre-audit panel yourself
2. Test on **BSC testnet** with small amounts
3. Treat **warnings** (especially fairness / integration-test items) as a human review checklist
4. Get an independent audit for anything with meaningful TVL

To launch a token with your vault on [Flap.sh](https://flap.sh), you will deploy through a **vault factory** with your contract bytecode. See the [Flap vault README](https://github.com/flap-sh/vaults) for the on-chain launch flow.

---

## Self-hosting (optional)

If you run the studio yourself instead of a hosted version: install Foundry and Node, set `OPENAI_API_KEY` in `server/.env.local`, then from the `web` folder run `npm run dev:all` and open http://localhost:5173. Details are in the repository README for developers.
