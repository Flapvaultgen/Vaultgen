# MechanicVault — Mechanism Description

> **For auditors:** authoritative spec of intended behavior. Any on-chain behavior that diverges is a bug.

## Summary

`MechanicVault` is a tax-funded **engine** that runs real on-chain mechanics — not just BNB routing. One `MechanicVaultFactory` serves every template; each template is a unique encoded `MechanicConfig`.

Mechanics:

1. **Buyback & Burn** — buys the tax token from the Flap Portal (bonding curve / DEX) and burns it.
2. **Survivor** — hold-to-survive elimination; survivors split a pot each round.
3. **Raffle** — holder lottery with periodic draws.
4. **Treasury + Creator fee** — pull-based reserves.

## Funding model (`receive()`)

`receive()` performs **pure accounting only** (no external calls), so tax dispatch can never be bricked and the 1M-gas receive budget is respected.

On each deposit of `amount`:

1. `creatorFeeAccrued += amount * creatorFeeBps / 10_000` (0–10%).
2. Of the remainder, allocate by bps to: `buybackBudget`, `survivorPot`, `rafflePrize[currentRaffleRound]`.
3. Everything left (explicit `treasuryBps` slice + rounding leftover) → `treasuryBalance`.

`buybackBps + survivorBps + raffleBps + treasuryBps ≤ 10_000` (enforced at deploy).

## Buyback & Burn

`executeBuyback(uint256 minTokensOut)`:

- Restricted to **creator or Guardian** (sandwich-sensitive; Guardian backup per Flap spec).
- Spends the entire `buybackBudget` via `IPortalTradeV2.swapExactInput{value}` (BNB → tax token) with `minTokensOut` slippage floor.
- Burns the bought tokens by transferring to the Flap black hole. If the token blocks the burn transfer, tokens stay **locked in the vault** (buyback-and-lock fallback) — still removed from circulation.
- Tracks `totalBoughtBack` (BNB) and `totalTokensBurned`.

This is a genuine bonding-curve interaction, verified on a BSC mainnet fork (`test/MechanicVault.mainnet.t.sol::test_executeBuyback_buysAndBurnsRealTokens`).

## Survivor (hold-to-survive elimination)

Round `r` ends at `deployTime + r * survivorRoundDuration`.

- `joinSurvivor()` — caller must hold `≥ survivorHoldThreshold` now; one join per round.
- `eliminate(address[])` — permissionless; any participant whose balance is now `< survivorHoldThreshold` is removed (objective on-chain condition). This reproduces "paper hands get cut, diamond hands survive".
- `endSurvivorRound()` — after the round ends: snapshot `survivorRoundPot[r] = survivorPot`, `survivorRoundSurvivors[r] = aliveCount`, reset `survivorPot`, advance round.
- `claimSurvivor(r)` — an alive survivor who **still** holds `≥ threshold` claims `survivorRoundPot[r] / survivorRoundSurvivors[r]`. One claim per address; forfeited shares remain in the contract.

## Raffle (holder lottery)

Round `r` ends at `deployTime + r * raffleRoundDuration`.

- `enterRaffle()` — caller must hold `≥ raffleMinHold`; one entry per round.
- `drawRaffle()` — after the round ends: pick winner `entrants[rand % n]`, pay `rafflePrize[r]`, advance round. With **no entrants**, the prize carries to the next round.

**Randomness caveat (audit-relevant):** the winner index uses block-derived entropy (`blockhash`, `block.timestamp`, `block.prevrandao`, nonce). This is **NOT cryptographically secure** and is manipulable by validators. For meaningful prizes, upgrade the draw to `FlapTriggerService` / a verifiable oracle. The AI Studio and UI both disclose this.

## Treasury & creator fee (pull)

- `withdrawTreasury()` — creator or Guardian; sends entire `treasuryBalance`.
- `withdrawCreatorFee()` — creator or Guardian; sends entire `creatorFeeAccrued` to the creator.

## Access control

| Function | Caller |
|----------|--------|
| `executeBuyback` | creator or Guardian |
| `withdrawTreasury`, `withdrawCreatorFee` | creator or Guardian |
| `joinSurvivor`, `claimSurvivor`, `enterRaffle` | anyone (gated by token holding) |
| `eliminate`, `endSurvivorRound`, `drawRaffle` | anyone (liveness / keeper) |

Guardian (`_getGuardian()`) retains backup access to all privileged functions, per Flap spec.

## What MechanicVault does NOT do

- No true VRF (raffle randomness is insecure — documented).
- No automatic per-block buyback (a keeper must call `executeBuyback`).
- No NFTs, lending, staking, reflections, cross-chain, or price-oracle triggers.
- No per-trade hooks inside the token — the vault only sees aggregated tax BNB.

## Tests

- Unit (local EVM): `forge test --match-contract MechanicVaultTest -vv`
- Mainnet fork: `forge test --match-path test/MechanicVault.mainnet.t.sol -vvv --fork-url https://bsc-dataseed.bnbchain.org`
