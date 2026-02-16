# SaySo — Permissionless AMM Prediction Market on Sei

SaySo is a permissionless AMM prediction market on the Sei network, designed to be usable without any crypto knowledge.

## Hard Rules (Never Break These)

1. **Browser-derived keys only.** All user transactions (bets, market creation, etc.) are signed by a private key derived in the browser from an email+password combo or passkey integration.
2. **Gas is always sponsored.** Every user transaction has its gas paid by the platform — users never pay gas. **Exception:** SAYSO governance voting (ResolutionOracle) is not gasless. Only internal team members hold SAYSO tokens initially, so this is acceptable for now.
3. **No testnet.** We deploy a mock USDC token on **mainnet** (Sei gas is cheap enough). The mock USDC must use the **exact same contract type and version** as the real USDC live on Sei mainnet.

## Contract Overview

### Token.sol — SAYSO Governance Token

- ERC-20 token with `onlyOwner` minting used exclusively for voting on market resolution.
- Max supply: 100M SAYSO.

### ResolutionOracle.sol — Voting & Resolution

- **Voting = staking.** To vote on a market, SAYSO holders transfer tokens directly to the oracle for that specific pool during its **resolution window**. The act of staking IS the vote.
- Each vote is **per-pool** — tokens staked on Pool A are independent from Pool B.
- Tokens are locked until the resolution window closes, then claimable.
- Once resolved (>50% majority determines the answer):
  - Voters on the **winning** side split the entire staked SAYSO pool for that market proportionally (their stake back + losers' stakes).
  - Voters on the **losing** side are **slashed** (they lose their staked SAYSO).
- If no votes are cast, markets resolve with proportional USDC refunds to bettors.
- **Market validation:** Oracle validates pool addresses via `factory.isMarket()` to prevent voting on fake pools and CREATE2 pre-voting attacks.

### AMM.sol — Individual Market Pool

- Each market is a standalone AMM pool using **LMSR (Logarithmic Market Scoring Rule)** bonding curve for automated market making.
- **Betting window:** period when users can place bets (buy/sell shares).
- **Resolution window:** period when SAYSO holders vote via the ResolutionOracle.
- After resolution:
  - The pool reads the result from the ResolutionOracle.
  - **Winning** users claim proportional shares of the total USDC pool.
  - **Losing** users are slashed (receive nothing).
  - **Tied votes:** Proportional refunds to all bettors (explicit `isTie` flag and event).
  - **No votes:** Proportional refunds to all bettors based on share ownership.
- **Fee:** 0.5% on every bet, sent to a configurable fee collector address.
- **Flash loan protection:** 10-block minimum hold time before selling (~4 seconds on Sei).
- **Internal accounting:** Uses `totalDeposited` to track net USDC deposited through trading, preventing donation attacks and making resolve timing manipulation irrelevant.
- **Minimum deposits:** 1 USDC minimum per trade (`MIN_DEPOSIT`), 10 USDC minimum seed for new markets (`MIN_SEED`), preventing share inflation attacks.
- **LMSR pricing:** Uses PRBMath library for fixed-point arithmetic with 18 decimal precision. Proper slippage on large trades, bounded loss for liquidity providers.

### Forwarder.sol — Gasless Meta-Transactions

- ERC-2771 trusted forwarder enabling gasless betting on AMM pools.
- The platform backend relays user-signed transactions and pays gas on their behalf.

### MarketFactory.sol — Market Deployment

- Allows any user to deploy a new AMM market pool (permissionless).
- Tracks all deployed markets via `isMarket` mapping for oracle validation.
- Provides paginated `getMarkets(offset, limit)` to prevent DoS with large market arrays.
- Provides view functions for market status (trading, resolution, resolved).
- Admin can update the oracle, trading token, forwarder, and fee collector for **new** markets.
- All admin changes emit events for transparency.

### MockUSDC.sol — Mock USDC (Mainnet)

- Production-grade mock matching Circle's USDC parameters: name="USD Coin", EIP-712 version="2".
- Supports ERC-2612 permit for gasless approvals.
- Open `mint()` — acceptable for mock/play money; will be replaced with real USDC for production.
