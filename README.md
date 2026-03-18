# SaySo Prediction Market Contracts

A permissionless AMM prediction market protocol on Sei, designed to be usable without any crypto knowledge.

## Overview

Users trade on binary outcome markets (YES/NO) using USDC. All betting is gasless via ERC-2771 meta-transactions. SAYSO governance token holders vote to resolve markets by staking tokens during the resolution window.

### Contracts

| Contract               | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `AMM.sol`              | Individual market pool — buy/sell YES/NO shares with USDC                       |
| `ResolutionOracle.sol` | Voting = staking. SAYSO holders vote per-pool during the resolution window      |
| `MarketFactory.sol`    | Permissionless factory for deploying new markets                                |
| `SaySoToken.sol`       | SAYSO governance token (onlyOwner mint, 1B max supply)                          |
| `SaySoForwarder.sol`   | ERC-2771 trusted forwarder for gasless meta-transactions                        |
| `MockUSDC.sol`         | Mock USDC matching Circle's real USDC on Sei (EIP-712 name="USDC", version="2") |
| `LMSR.sol`             | Logarithmic Market Scoring Rule library using PRBMath                           |

### Deployed Addresses (Sei Mainnet)

See [deployments.json](deployments.json).

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

**Test Suite Status: 221/221 tests passing (100%)**

Comprehensive test coverage across 18 test files:

- **E2E Tests** (9) - Full lifecycle with invariant checks
- **LMSR Library** (19) - Complete LMSR math verification
- **LMSR Precision** (19) - Precision and rounding for LMSR calculations
- **Edge Cases** (18) - MIN_DEPOSIT boundaries, ties, no-votes scenarios
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

### Deploy demo environment to Sei

```bash
npx hardhat run scripts/deploy-demo.ts --network sei
```

### Deploy production environment to Sei

```bash
npx hardhat run scripts/deploy-prod.ts --network sei
```

Deployment deploys in dependency order:

1. MockUSDC (demo only), SaySoToken, SaySoForwarder (no dependencies)
2. ResolutionOracle (needs SaySoToken, SaySoForwarder)
3. MarketFactory (needs USDC/MockUSDC, ResolutionOracle, SaySoForwarder)
4. Wire oracle ↔ factory circular dependency

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

### Supported gasless functions

- `buyYes(amount)` / `buyNo(amount)`
- `sellYes(shares)` / `sellNo(shares)`
- `claim()`

## EIP-712 Domains

| Contract           | Name             | Version | Notes                                 |
| ------------------ | ---------------- | ------- | ------------------------------------- |
| MockUSDC (demo)    | `USDC`           | `2`     | Matches Circle USDC on Sei            |
| Circle USDC (prod) | `USDC`           | `2`     | Native Circle USDC                    |
| SaySoForwarder     | `SaySoForwarder` | `1`     | ForwardRequest uses `uint48 deadline` |

## Development

Built with:

- Solidity 0.8.28
- Hardhat 3
- Viem
- OpenZeppelin Contracts 5.x
- PRBMath (fixed-point arithmetic for LMSR)

## License

UNLICENSED
