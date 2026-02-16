# Changelog

All notable changes to the SaySo smart contracts will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-15

### Core

- **LMSR Implementation** - Automated market making with bonding curve:
  - Logarithmic Market Scoring Rule (LMSR) bonding curve for proper slippage
  - `contracts/libraries/LMSR.sol` with PRBMathSD59x18 for fixed-point arithmetic
  - Cost function: `C(q) = b * ln(e^(q_yes/b) + e^(q_no/b))`
  - Price calculation: `p_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b))`
  - Liquidity parameter `b` controls market depth and slippage

- **Atomic Market Seeding** in `MarketFactory.sol`:
  - `initialYesTokens` and `initialNoTokens` parameters in `createMarket()`
  - Factory handles token transfer from creator → factory → market
  - Creator receives initial shares as liquidity provider
  - No fees charged on seed liquidity (only on trading)

### Security

- **Internal Accounting System** in `AMM.sol`:
  - `totalDeposited` state variable tracks net USDC deposited through trading
  - `resolve()` uses `totalDeposited` instead of `balanceOf()` for `resolvedPoolBalance`
  - Prevents donation attacks and resolve timing manipulation

- **Oracle Registry Validation** in `ResolutionOracle.sol`:
  - `IMarketFactory` interface for market validation
  - `validMarket` modifier checks `factory.isMarket(pool)`
  - Applied to `voteYes()` and `voteNo()` functions

- **Minimum Deposit Requirements**:
  - `MIN_DEPOSIT = 1e6` (1 USDC minimum per trade) in `AMM.sol`
  - `MIN_SEED = 10e6` (10 USDC minimum seed) in `MarketFactory.sol`
  - Prevents share inflation attacks

- **Flash Loan Protection**:
  - `MIN_HOLD_BLOCKS = 10` (~4 seconds on Sei)
  - Prevents same-block buy/sell arbitrage

- **Tie Handling** in `AMM.sol`:
  - `isTie` state variable and `MarketResolvedWithTie` event
  - Proportional refund logic for tied markets

- **Zero-Address Validation** in all constructors and admin setter functions

- **Configurable Fee Collector**:
  - `feeCollector` state variable (not hardcoded)
  - `setFeeCollector()` admin function in MarketFactory

- **Admin Events**:
  - `OracleUpdated`, `TradingTokenUpdated`, `TrustedForwarderUpdated`, `FeeCollectorUpdated` in MarketFactory
  - `FactoryUpdated` in ResolutionOracle

### Infrastructure

- **Paginated Market Getters** in `MarketFactory.sol`:
  - `getMarkets(offset, limit)` for scalable market listing

- **ERC-2771 Gasless Transactions** via SaySoForwarder

- **ERC-2612 Permit** for gasless USDC approvals

### Testing

- 183/183 tests passing (100%) across 17 test files
- Comprehensive test suite: E2E, LMSR math, invariants, security, edge cases, admin mutations, view functions, state transitions, failure modes, precision, meta-transactions, extreme values, economic attacks, multi-user scenarios, market seeding
- See [TESTING.md](TESTING.md) for detailed documentation

### Deployed (Sei Mainnet)

- MockUSDC: `0xad1e5b9cc88da1fb2319e38958edabcbf597ff0d`
- SaySoToken: `0x136815fbf6a8d097465c91c9ab25872807d17371`
- SaySoForwarder: `0xf920aaf29cae064fe2a47069cb86f9357ac65b9b`
- ResolutionOracle: `0xc7ec37ac0654a7c85ce860d9e875a07dc2d636b4`
- MarketFactory: `0x3c32f754a5b0ed4f0880c6f37021750ed742dd78`
