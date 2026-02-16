# SaySo Prediction Market Contracts

A permissionless AMM prediction market protocol on Sei, designed to be usable without any crypto knowledge.

## Overview

Users trade on binary outcome markets (YES/NO) using USDC. All betting is gasless via ERC-2771 meta-transactions. SAYSO governance token holders vote to resolve markets by staking tokens during the resolution window.

### Contracts

| Contract | Description |
|---|---|
| `AMM.sol` | Individual market pool — buy/sell YES/NO shares with USDC |
| `ResolutionOracle.sol` | Voting = staking. SAYSO holders vote per-pool during the resolution window |
| `MarketFactory.sol` | Permissionless factory for deploying new markets |
| `SaySoToken.sol` | SAYSO governance token (onlyOwner mint, 100M max supply) |
| `SaySoForwarder.sol` | ERC-2771 trusted forwarder for gasless meta-transactions |
| `MockUSDC.sol` | Mock USDC matching Circle's real USDC on Sei (name="USD Coin", version="2") |

### Deployed Addresses (Sei Mainnet)

| Contract | Address |
|---|---|
| MockUSDC | `0xad1e5b9cc88da1fb2319e38958edabcbf597ff0d` |
| SaySoToken | `0x136815fbf6a8d097465c91c9ab25872807d17371` |
| SaySoForwarder | `0xf920aaf29cae064fe2a47069cb86f9357ac65b9b` |
| ResolutionOracle | `0xc7ec37ac0654a7c85ce860d9e875a07dc2d636b4` |
| MarketFactory | `0x3c32f754a5b0ed4f0880c6f37021750ed742dd78` |

See [deployments.json](deployments.json) for full details.

## Market Lifecycle

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Trading   │───>│   Trading   │───>│   Voting    │───>│   Claim     │
│   Opens     │    │   Closes    │    │   Period    │    │   Period    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
  effectiveFrom      effectiveTo      resolutionOpen    resolutionClose
```

**Trading:** Users buy/sell YES and NO shares with USDC. 0.5% fee on every bet. 10-block minimum hold before selling (flash loan protection). Internal accounting system prevents donation attacks and makes resolve timing manipulation irrelevant.

**Voting:** SAYSO holders vote by staking tokens directly to the oracle for a specific pool. The act of staking IS the vote. Tokens are locked until the resolution window closes.

**Resolution:** >50% majority determines the outcome. Winners split the entire USDC pool proportionally. Losers get nothing. If no votes are cast, all bettors get proportional USDC refunds. Tied votes trigger proportional refunds.

**Voter payouts:** Winning voters get their stake back + losers' staked SAYSO. Losing voters are slashed.

## Installation

```bash
npm install
```

## Configuration

```bash
cp .env.example .env
# Edit .env with your deployer private key
```

## Testing

```bash
npm test
```

**Test Suite Status: 183/183 tests passing (100%)**

Comprehensive test coverage across 17 test files:
- **E2E Tests** (9) - Full lifecycle with invariant checks
- **LMSR Library** (19) - Complete LMSR math verification
- **Edge Cases** (17) - MIN_DEPOSIT boundaries, ties, no-votes scenarios
- **Admin Mutations** (17) - Factory admin function behavior
- **View Functions** (17) - Read-only contract functions
- **Security** (15) - Flash loan protection, access control, reentrancy
- **State Transitions** (13) - Market phase transitions
- **Failure Modes** (13) - Error handling and reverts
- **Precision** (11) - Numerical precision and rounding
- **Meta Transactions** (11) - ERC-2771 gasless operations
- **Invariants** (10) - Conservation laws, donation attack immunity
- **Extreme Values** (10) - Overflow/underflow edge cases
- **Economic Attacks** (8) - Attack vector resistance
- **Multi-User Scenarios** (6) - Complex multi-party interactions
- **Market Seeding** (4) - Various liquidity configurations
- **LMSR Pricing** (2) - Pricing correctness validation
- **Walkthrough** (1) - Verbose 4-user journey with logging

See [TESTING.md](TESTING.md) for detailed test documentation.

## Deployment

### Deploy all contracts to Sei

```bash
npx hardhat run scripts/deploy-all.ts --network sei
```

This deploys in dependency order:
1. MockUSDC, SaySoToken, SaySoForwarder (no dependencies)
2. ResolutionOracle (needs SaySoToken)
3. MarketFactory (needs MockUSDC, ResolutionOracle, SaySoForwarder)

Writes all addresses to `deployments.json` automatically.

## Gasless Transactions (ERC-2771)

```
┌─────────┐     ┌─────────────┐     ┌───────────────────┐
│  User   │────>│  Relayer    │────>│  SaySoForwarder   │
│ (signs) │     │ (pays gas)  │     │  (verifies sig)   │
└─────────┘     └─────────────┘     └─────────┬─────────┘
                                              │
                                              v
                                    ┌─────────────────┐
                                    │   AMM Contract  │
                                    │ (ERC2771Context)│
                                    └─────────────────┘
```

1. User signs an EIP-712 meta-transaction request in the browser
2. Backend relayer calls `SaySoForwarder.execute()` and pays gas
3. AMM's `_msgSender()` extracts the real user address from forwarded calldata

USDC approvals are also gasless via ERC-2612 `permit()` signatures.

**Exception:** SAYSO voting on the ResolutionOracle is not gasless. Only internal team members hold SAYSO initially.

### Supported gasless functions

- `buyYes(amount)` / `buyNo(amount)`
- `sellYes(shares)` / `sellNo(shares)`
- `claim()`

## Development

Built with:
- Solidity 0.8.28
- Hardhat 3
- Viem
- OpenZeppelin Contracts 5.x
- PRBMath (fixed-point arithmetic for LMSR)

## License

UNLICENSED
