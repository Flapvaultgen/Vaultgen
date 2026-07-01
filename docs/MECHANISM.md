# ComposerVault — Mechanism Description

> **For auditors:** This document is the authoritative description of intended behavior. Any on-chain behavior that diverges from this description should be treated as a bug or security issue.

## Summary

`ComposerVault` is a **configurable tax-revenue router** for Flap V3 tax tokens. Each token launch deploys a fresh vault instance via `ComposerVaultFactory`. The vault receives native BNB from the token's `TaxProcessor` (as `marketAddress`) and executes a **fixed, ordered pipeline** of up to 12 blocks defined at launch time in `vaultData`.

`ComposerVaultFactory` is a **meta-factory**: one factory contract serves all templates. Each template is a unique `ComposerConfig` (name, creator fee, block list) encoded in `vaultData` — not a separate factory per product.

## Actors

| Actor | Role |
|-------|------|
| **VaultPortal** | Only caller allowed to invoke `ComposerVaultFactory.newVault()` |
| **TaxProcessor** | Sends accumulated market-tax BNB to the vault on `dispatch()` |
| **Template creator** | Receives creator fee on every deposit; may call `withdrawTreasury()` |
| **Flap Guardian** | May call inherited emergency hooks and `withdrawTreasury()` |
| **Split / send recipients** | Receive BNB immediately when their pipeline block runs |
| **Community claimers** | May call `claim()` once each if a `CLAIM_POOL` block is configured |

## Configuration (`vaultData`)

`vaultData` ABI-decodes to:

```solidity
struct ComposerConfig {
    string templateName;
    uint16 creatorFeeBps;      // 0–1000 (0–10%)
    ComposerBlock[] blocks;    // max 12
}

struct ComposerBlock {
    BlockType blockType;       // SPLIT | SEND | TREASURY | CLAIM_POOL
    bytes data;                // block-specific payload
}
```

Factory validation (at deploy time):

- Non-empty `templateName`
- `creatorFeeBps ≤ 1000`
- `blocks.length ≤ 12`
- **SPLIT:** 1–10 recipients, non-zero addresses, bps sum = 10_000
- **SEND:** non-zero bps ≤ 10_000, non-zero recipient (validated at runtime transfer)
- **TREASURY:** non-zero bps ≤ 10_000
- **CLAIM_POOL:** non-zero bps ≤ 10_000, non-zero `maxPerClaim`

Only **native BNB** quote tokens are supported (`quoteToken == address(0)`).

## Revenue flow (`receive()`)

When the vault receives native BNB (typically from `TaxProcessor.dispatch()`):

1. **Creator fee** — `creatorFeeBps` of the incoming amount is sent immediately to `templateCreator`.
2. **Pipeline** — blocks execute **in array order** on the remaining BNB. Each block operates on **what is left after prior blocks** in the same transaction.
3. **Leftover** — any BNB still remaining after all blocks is added to `treasuryBalance`.

### Block semantics

| Block | Behavior |
|-------|----------|
| **SEND** | Take `bps`% of remaining BNB; transfer that slice to one address. |
| **SPLIT** | Divide **100%** of remaining BNB across recipients by bps weights (must total 10_000). Dust from integer division stays in remaining for later blocks. |
| **TREASURY** | Take `bps`% of remaining; add slice to `treasuryBalance` (not transferred out). |
| **CLAIM_POOL** | Take `bps`% of remaining; add slice to `poolBudget`. Pool params (`maxPerClaim`, `claimCooldown`) are read from the **first** `CLAIM_POOL` block at construction. |

**Important:** Percentages are applied to **remaining** BNB at each step, not the original deposit. Order matters.

## Treasury withdrawal

`withdrawTreasury()`:

- Callable by `templateCreator` or Flap Guardian
- Transfers entire `treasuryBalance` to `msg.sender` and resets balance to zero
- Reverts if `treasuryBalance == 0`

## Community claim pool

Enabled iff the config contains at least one `CLAIM_POOL` block.

`claim()`:

- One claim per address (`hasClaimed` mapping)
- Global cooldown: `nextClaimTime` must be ≤ `block.timestamp`
- Payout = `min(contract.balance, maxPerClaim, poolBudget)` (whichever binds first)
- On success: marks claimer, advances `nextClaimTime` by `claimCooldown`, decrements `poolBudget`
- Reverts if pool disabled, already claimed, cooldown active, or nothing to pay

**Note:** Claim pays from the vault's **live native balance**, capped by `poolBudget` accounting. Pipeline execution may also leave BNB in treasury or send to external wallets in the same transaction as tax deposits.

## What this vault does NOT do

- No bonding-curve logic, VRF games, or token swaps
- No automatic re-buy or AI oracle integration
- No per-trade logic — only reacts to incoming native BNB
- No upgradeability — config is immutable after deploy
- Does not clone or delegate to external CA STORE vault factories

## Integration with Flap Protocol

1. Creator launches via `VaultPortal.newTokenV6WithVault()` with `vaultFactory = ComposerVaultFactory` and encoded `vaultData`.
2. VaultPortal calls `factory.newVault(taxToken, …, creator, vaultData)`.
3. Tax token's `TaxProcessor.marketAddress` is set to the new vault.
4. On trades, tax BNB accumulates in `TaxProcessor`; anyone may call `dispatch()` to forward market share to the vault.
5. Vault `receive()` runs the pipeline.

## UI surface

- `description()` — human-readable treasury + pool balances
- `vaultUISchema()` — exposes `getPoolInfo`, `claim`, `withdrawTreasury`
- `vaultDataSchema()` on factory — points authors to Origin AI Studio encoded config

## Security assumptions

- Recipients of SEND/SPLIT must accept native transfers (EOA or contract with payable receive/fallback)
- Template creator is trusted to configure intended wallets at launch
- Guardian emergency hooks inherited from `VaultBaseV2` remain available per Flap spec

## Test references

Mainnet-fork integration tests: `test/ComposerVault.mainnet.t.sol`

Run:

```bash
forge test --match-path test/ComposerVault.mainnet.t.sol -vvv \
  --fork-url https://bsc-dataseed.bnbchain.org
```
