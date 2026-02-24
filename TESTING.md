# Testing Documentation

## Overview

The SaySo smart contract test suite provides comprehensive coverage of all contract functionality, security measures, edge cases, and mathematical correctness. All 221 tests pass successfully across 18 test files, validating the production-readiness of the contracts.

**Test Status: 221/221 passing (100%)**

## Test Framework

- **Framework:** Node.js native test framework (`node:test`)
- **Assertions:** Node.js strict assertions (`node:assert/strict`)
- **Blockchain:** Hardhat 3 with Viem for contract interactions
- **Network:** Local Hardhat node simulating Sei mainnet (chainId 1329)

## Test Suite Structure

### 1. E2E Tests (9 tests) - `test/E2E.ts`

End-to-end tests covering the complete market lifecycle from creation to resolution and claiming.

#### Tests:
1. **Complete market lifecycle: create → trade → vote → resolve → claim**
   - Creates market with 10 USDC seed liquidity
   - Multiple users trade YES and NO shares
   - SAYSO holders vote during resolution window
   - Market resolves correctly based on votes
   - Winners claim proportional payouts
   - Verifies all invariants hold throughout

2. **Trading period enforcement**
   - Cannot buy before effectiveFrom
   - Can buy during trading period
   - Cannot buy after effectiveTo
   - Time-based access control works correctly

3. **Resolution timing enforcement**
   - Cannot vote before resolutionOpen
   - Can vote during resolution window
   - Cannot vote after resolutionClose
   - Proper voting window boundaries

4. **Market creation validation**
   - Rejects markets with invalid timeline (resolutionOpen before effectiveTo)
   - Rejects markets with resolutionClose before resolutionOpen
   - Requires logical ordering: effectiveFrom < effectiveTo < resolutionOpen < resolutionClose

5. **Fee collection**
   - 0.5% fee deducted from every buy transaction
   - Fees transferred to FEE_COLLECTOR address
   - Net amount after fees used for share calculation

6. **Oracle voting mechanics**
   - SAYSO holders stake tokens to vote
   - Tokens locked until resolution window closes
   - Winning voters receive their stake back + slashed tokens from losers
   - Losing voters lose their staked tokens

7. **Winner payouts are proportional**
   - Winners split entire USDC pool based on their share proportions
   - Losers get nothing
   - Payout calculation uses resolved pool balance

8. **No double claiming**
   - First claim succeeds and transfers tokens
   - Second claim attempt reverts
   - Prevents draining attack

9. **LMSR pricing responds to trades**
   - Price increases when YES bought
   - Price decreases when NO bought
   - Price bounded between 0% and 100%
   - Reflects supply/demand dynamics

### 2. LMSR Library Tests (19 tests) - `test/LMSR.ts`

Mathematical validation of the Logarithmic Market Scoring Rule implementation using PRBMath.

#### Tests:

**Basic Math Functions:**
1. **exp18() handles zero** - e^0 = 1
2. **exp18() handles positive values** - e^1 ≈ 2.718
3. **exp18() handles negative values** - e^-1 ≈ 0.368
4. **exp18() handles large values without overflow** - Bounded to prevent overflow
5. **ln() handles e (natural log base)** - ln(e) = 1
6. **ln() handles 1** - ln(1) = 0
7. **ln() handles values > 1** - ln(10) ≈ 2.303
8. **ln() handles values < 1** - ln(0.5) ≈ -0.693
9. **ln() reverts on zero** - ln(0) is undefined

**Cost Function:**
10. **costFunction() with equal quantities returns expected value**
    - Verifies C(q, q) formula correctness
11. **costFunction() increases with quantity**
    - Monotonically increasing function
12. **costFunction() is symmetric** - C(a, b) relates properly to C(b, a)

**Buy Cost:**
13. **buyCost() increases with quantity** - More shares cost more
14. **buyCost() has reasonable values** - Sanity check on pricing
15. **buyCost() for small amounts is proportional** - Linear for small trades

**Sell Payout:**
16. **sellPayout() decreases with quantity** - Selling moves price down
17. **sellPayout() reverts if insufficient shares** - Cannot sell more than owned

**Price Calculation:**
18. **priceYes() starts at 50% with equal quantities** - Fair initial price
19. **priceYes() increases when YES quantity increases** - Supply affects price

**Key Properties Verified:**
- Exponential and logarithm functions work correctly across ranges
- Cost function is monotonic and bounded
- Buy and sell operations affect price appropriately
- Price stays within [0%, 100%] bounds
- No overflow errors with extreme values

### 3. Invariant Tests (10 tests) - `test/Invariants.ts`

Tests verifying conservation laws and attack immunity throughout market operations.

#### Tests:

**Conservation Laws:**
1. **Total supply conservation: YES + NO shares = total minted**
   - After multiple buys and sells by different users
   - Internal accounting matches actual balances
   - No shares created or destroyed improperly

2. **USDC accounting: deposits - withdrawals = contract balance**
   - `totalDeposited` tracks net USDC flow
   - Matches actual token balance (excluding fees)
   - Buy increases, sell decreases totalDeposited

3. **Share balances sum correctly**
   - Sum of all user YES balances = totalYesShares
   - Sum of all user NO balances = totalNoShares
   - No orphaned or duplicated shares

**Donation Attack Immunity:**
4. **Direct USDC transfer does not affect resolvedPoolBalance**
   - Attacker sends USDC directly to pool contract
   - Pool resolves using `totalDeposited`, not `balanceOf()`
   - Donation has no effect on payouts
   - Internal accounting prevents manipulation

5. **Donation before resolution doesn't affect claims**
   - Donor gets no shares for direct transfer
   - Winners' claims unaffected by donation
   - Extra USDC remains in contract (not distributed)

6. **Multiple donations don't break accounting**
   - Sequential donations from different addresses
   - `totalDeposited` remains accurate
   - Resolution uses correct balance

**Market State Invariants:**
7. **Cannot trade after market closed**
   - Time-based restrictions enforced
   - Buy and sell functions revert after effectiveTo

8. **Cannot claim before resolution**
   - Attempting to claim unresolved market reverts
   - Must wait for oracle outcome

9. **Cannot vote outside resolution window**
   - Voting before resolutionOpen reverts
   - Voting after resolutionClose reverts

10. **Flash loan protection: MIN_HOLD_BLOCKS enforced**
    - Must hold shares for 10 blocks before selling
    - Prevents same-block buy/sell arbitrage
    - Block number tracking works correctly

11. **Resolved outcome is immutable**
    - Calling resolve() second time reverts
    - Outcome cannot change after resolution
    - Prevents manipulation after voting

### 4. Security Tests (15 tests) - `test/Security.ts`

Tests covering access control, reentrancy protection, and attack vectors.

#### Tests:

**Access Control:**
1. **Only owner can setOracle on factory**
   - Non-owner call reverts
   - Owner call succeeds
   - Prevents unauthorized oracle changes

2. **Only owner can setTradingToken on factory**
   - Protects against token substitution attacks

3. **Only owner can setTrustedForwarder on factory**
   - Prevents gasless transaction hijacking

**Reentrancy Protection:**
4. **buyYes cannot reenter**
   - Uses `nonReentrant` modifier from OpenZeppelin
   - Second call during execution reverts

5. **sellYes cannot reenter**
   - Prevents withdraw-and-reenter attacks

6. **claim cannot reenter**
   - Protects payout function from reentrancy

7. **voteYes on oracle cannot reenter**
   - Voting function is reentrancy-safe

**Flash Loan Protection:**
8. **Cannot buy and sell in same block**
   - MIN_HOLD_BLOCKS = 10 enforced
   - Sell immediately after buy reverts
   - Must wait for block advancement

9. **Can sell after MIN_HOLD_BLOCKS**
   - After mining 10 blocks, sell succeeds
   - Time-based restriction lifts correctly

10. **Exact boundary: cannot sell at 9 blocks, can sell at 10**
    - Buy at block N
    - Sell transaction at block N+9 reverts
    - Sell transaction at block N+10 succeeds
    - **Note:** Transaction execution happens in new block

11. **Flash loan protection per address**
    - Alice buys, Bob immediately buys
    - Alice sells successfully (met hold period)
    - Bob cannot sell yet (his hold period separate)

**Zero-Address Validation:**
12. **Factory constructor rejects zero address for oracle**
    - Validates critical constructor parameters
    - Prevents deployment with invalid addresses

13. **Factory constructor rejects zero address for trading token**
    - Ensures token address is valid

### 5. Edge Cases Tests (18 tests) - `test/EdgeCases.ts`

Boundary conditions and unusual scenarios.

#### Tests:

**Minimum Deposit Enforcement:**
1. **Cannot buy with amount below MIN_DEPOSIT (1 USDC)**
   - Reverts with "Deposit below minimum"
   - Prevents share inflation attacks

2. **Can buy with exactly MIN_DEPOSIT**
   - Boundary case: exactly 1 USDC succeeds

3. **Cannot create market below MIN_SEED (10 USDC)**
   - Factory enforces minimum seed liquidity
   - Prevents manipulation via tiny liquidity

4. **Can create market with exactly MIN_SEED**
   - 5 USDC YES + 5 USDC NO = 10 USDC total seed

**Zero Amount Validation:**
5. **Cannot buy with 0 amount**
   - Reverts with "Amount must be greater than 0"
   - Input validation on buy functions

6. **Cannot sell 0 shares**
   - Reverts with "Shares must be greater than 0"
   - Input validation on sell functions

**Tie Scenarios:**
7. **Equal YES and NO votes result in explicit tie**
   - 100 SAYSO on YES, 100 SAYSO on NO
   - `isTie` flag set to true
   - Event: `MarketResolvedWithTie` emitted
   - Default outcome: NO (documented behavior)

8. **Tie results in proportional refunds**
   - In tie scenario, users get refunds based on share proportions
   - Not winner-take-all
   - Fair outcome when vote is tied

**No Votes Scenarios:**
9. **No votes on resolved market: proportional refunds**
   - If no one votes, market resolves with outcome = false
   - All bettors get proportional refunds based on their shares
   - No winner, no loser

10. **No votes with single bettor: full refund**
    - Alice bets 500 USDC on YES in 10 USDC pool
    - No votes cast
    - Alice gets substantial refund (accounting for LMSR slippage)
    - Refund between 40-100% of net deposit (slippage-dependent)

11. **No votes with balanced betting: symmetric refunds**
    - Equal betting on YES and NO
    - No votes cast
    - Both sides get symmetric refunds

**Large Trade Scenarios:**
12. **Large buy relative to pool size (50x)**
    - 500 USDC buy on 10 USDC pool
    - LMSR handles extreme imbalance
    - Massive slippage but no overflow

13. **Large sell relative to holdings**
    - Cannot sell more shares than owned
    - Reverts with "Insufficient shares"

**Extreme Imbalances:**
14. **Pool with 99% YES, 1% NO**
    - LMSR pricing handles extreme skew
    - Price approaches but doesn't exceed 100%

15. **Pool with 1% YES, 99% NO**
    - Price approaches but doesn't go below 0%
    - No underflow errors

### 6. Market Lifecycle Walkthrough (1 test) - `test/Walkthrough.ts`

Verbose, logged journey through complete market with 4 users, demonstrating all features.

#### Test:
**Complete 4-user market journey with verbose logging**

**Participants:**
- Alice: Buys YES, votes YES
- Bob: Buys NO, votes NO
- Charlie: Buys YES, doesn't vote
- Dave: Buys NO, doesn't vote

**Timeline:**
1. **Market Creation** (Block 0)
   - Creator seeds 5 USDC YES + 5 USDC NO = 10 USDC liquidity
   - Initial price: ~50%

2. **Trading Period** (Blocks 1-5)
   - Alice buys 100 USDC YES → price rises to ~75%
   - Bob buys 100 USDC NO → price drops to ~52%
   - Charlie buys 50 USDC YES → price rises to ~65%
   - Dave buys 30 USDC NO → price drops to ~58%
   - Logs all purchases with resulting prices and shares

3. **Resolution Period** (Blocks 10-15)
   - Alice stakes 100 SAYSO for YES
   - Bob stakes 150 SAYSO for NO
   - NO wins (150 > 100)
   - Bob gets his 150 SAYSO back + Alice's 100 SAYSO = 250 total
   - Alice loses her 100 SAYSO stake (slashed)

4. **Claiming** (Block 20)
   - Bob and Dave claim their winnings (NO winners)
   - Alice and Charlie get nothing (YES losers)
   - Logs all claim amounts
   - Verifies total claims = resolvedPoolBalance

**Purpose:**
- Human-readable walkthrough of entire protocol
- Demonstrates realistic user interactions
- Validates economic incentives align correctly
- Useful for understanding protocol behavior

### 7. Market Seeding Tests (4 tests) - `test/MarketSeeding.ts`

Tests for various initial liquidity configurations.

#### Tests:

1. **Equal seeding: 50 USDC YES, 50 USDC NO**
   - Initial price should be ~50%
   - Symmetric liquidity creates balanced market

2. **Skewed seeding: 70 USDC YES, 30 USDC NO**
   - Initial price should favor YES (~70%)
   - Creator can set initial market sentiment

3. **Minimal seeding: 5 USDC YES, 5 USDC NO**
   - Exactly MIN_SEED (10 USDC total)
   - Works but has high slippage

4. **Asymmetric seeding: 90 USDC YES, 10 USDC NO**
   - Extreme initial bias (~90% YES)
   - Still functional, but very skewed market

### 8. LMSR Precision Tests (19 tests) - `test/LMSRPrecision.ts`

Tests for numerical precision and rounding behavior in LMSR calculations across various magnitudes and edge cases.

#### Tests:
- Precision of exp18/ln functions across value ranges
- Cost function precision with small and large inputs
- Buy/sell cost precision at various pool sizes
- Price calculation accuracy near boundaries (0%, 50%, 100%)
- Round-trip consistency (buy then sell returns similar amount)
- Precision under extreme liquidity parameters

### 9. LMSR Pricing Tests (2 tests) - `test/LMSRPricing.ts`

Tests validating LMSR pricing correctness.

#### Tests:

1. **NO side pricing uses correct cost curve parameters**
   - Verifies that buyNo correctly computes cost using LMSR
   - Ensures NO side isn't double-swapping parameters

2. **LMSR binary search finds correct shares for cheap prices**
   - Tests that sharesForCost works with low-probability outcomes
   - Upper bound calculation handles extreme cases

### 10. Admin Mutations (17 tests) - `test/AdminMutations.ts`

Tests for factory admin functions: setOracle, setTradingToken, setTrustedForwarder, setFeeCollector. Verifies that changes only affect new markets, not existing ones.

### 11. View Functions (17 tests) - `test/ViewFunctions.ts`

Tests for all read-only contract functions: price queries, balance checks, market status, oracle voting info, and paginated market getters.

### 12. State Transitions (13 tests) - `test/StateTransitions.ts`

Tests for market phase transitions: trading → resolution → resolved → claiming. Validates that functions are only callable in their correct phase.

### 13. Failure Modes (13 tests) - `test/FailureModes.ts`

Tests for expected error handling: insufficient balances, unauthorized access, invalid parameters, and graceful degradation.

### 14. Precision (11 tests) - `test/Precision.ts`

Tests for numerical precision in LMSR calculations, fee computations, and share/USDC conversions across various magnitudes.

### 15. Meta Transactions (11 tests) - `test/MetaTransactions.ts`

Tests for ERC-2771 gasless transaction support: buying, selling, and claiming via the trusted forwarder.

### 16. Extreme Values (10 tests) - `test/ExtremeValues.ts`

Tests for overflow/underflow edge cases, maximum trade sizes, and boundary conditions in LMSR math.

### 17. Economic Attacks (8 tests) - `test/EconomicAttacks.ts`

Tests for resistance to economic attack vectors: donation attacks, sandwich attacks, front-running, and manipulation attempts.

### 18. Multi-User Scenarios (6 tests) - `test/MultiUserScenarios.ts`

Tests for complex multi-party interactions: concurrent trading, voting conflicts, and claim ordering.

## Running Tests

### Run all tests:
```bash
npm test
```

### Run specific test file:
```bash
npx hardhat test test/E2E.ts
npx hardhat test test/Security.ts
npx hardhat test test/EdgeCases.ts
```

### Run with gas reporting:
```bash
REPORT_GAS=true npm test
```

## Test Coverage Summary

| Category | Tests | Coverage |
|----------|-------|----------|
| E2E Tests | 9 | Full lifecycle, all flows |
| LMSR Library | 19 | Complete math validation |
| LMSR Precision | 19 | Precision and rounding for LMSR |
| Edge Cases | 18 | Boundaries + ties + no-votes |
| Admin Mutations | 17 | Factory admin function behavior |
| View Functions | 17 | Read-only contract functions |
| Security | 15 | Access control + reentrancy + flash loans |
| State Transitions | 13 | Market phase transitions |
| Failure Modes | 13 | Error handling and reverts |
| Precision | 11 | Numerical precision and rounding |
| Meta Transactions | 11 | ERC-2771 gasless operations |
| Invariants | 10 | Conservation + attack immunity |
| Extreme Values | 10 | Overflow/underflow edge cases |
| Economic Attacks | 8 | Attack vector resistance |
| Multi-User Scenarios | 6 | Complex multi-party interactions |
| Market Seeding | 4 | Various liquidity configs |
| LMSR Pricing | 2 | Pricing correctness |
| Walkthrough | 1 | Realistic 4-user scenario |
| **Total** | **221** | **100% passing** |

## Key Test Insights

### 1. Block Timing in Tests

**Critical Discovery:** When you call a transaction function (e.g., `market.write.sellYes()`), that transaction executes in a NEW block, not the current block.

**Example:**
- Buy happens at block 13
- Mine 9 blocks → current block is 22
- Call `sellYes()` → transaction executes at block 23 (10 blocks after purchase)
- This is exactly at MIN_HOLD_BLOCKS boundary

**Implication for Flash Loan Tests:**
- To test "cannot sell at 9 blocks," mine only 8 blocks
- To test "can sell at 10 blocks," mine 9 blocks
- Transaction execution advances the block counter

### 2. LMSR Slippage

**Observation:** Large trades relative to pool size have massive slippage.

**Example:**
- 10 USDC pool (5 YES + 5 NO)
- Alice buys 500 USDC YES (50x pool size)
- Due to LMSR bonding curve, she only gets ~400 USDC worth of shares
- 20% slippage on this extreme trade
- This is expected behavior, not a bug

**Implication for Refund Tests:**
- No-votes refunds are based on share proportions, not deposit amounts
- Large trades get lower refund percentages due to slippage
- Tests must account for realistic LMSR behavior

### 3. Internal Accounting

**Pattern:** `totalDeposited` tracks actual net USDC flow through trading.

**Updates:**
- `buyYes()` → `totalDeposited += netAmount`
- `sellYes()` → `totalDeposited -= payout`
- `resolve()` → `resolvedPoolBalance = totalDeposited`

**Benefit:**
- Direct USDC transfers (donations) don't affect `totalDeposited`
- `resolvedPoolBalance` reflects only legitimate trading volume
- Prevents donation attack manipulation

### 4. Test Reliability

**RPC Sync Lag:**
- Sometimes Hardhat RPC doesn't update immediately
- Tests use retry loops with polling for on-chain state checks
- Example: After mining blocks, wait and retry balance checks

**Transaction Ordering:**
- Tests must mine blocks explicitly using `helpers.mine()`
- Cannot assume transactions happen in specific blocks without mining

## Security Properties Verified

- Donation attacks prevented via internal accounting
- Seed liquidity not locked, creator receives shares
- Share inflation attacks prevented via MIN_DEPOSIT
- Resolve timing manipulation irrelevant with internal accounting
- Flash loan protection with 10-block hold period
- Tie scenarios handled explicitly with refunds
- Zero-address validation in constructors

## Mathematical Properties Verified

- Exponential and logarithm functions accurate
- LMSR cost function monotonically increasing
- Buy cost increases with quantity
- Sell payout decreases with quantity (moving price down)
- Price bounded [0%, 100%]
- Price responds correctly to supply changes
- No overflow with extreme values

## Economic Properties Verified

- Fee collection (0.5% on all buys)
- Winner-take-all payout model
- Proportional payouts based on share ownership
- No double claiming
- Voter incentives align correctly (winners rewarded, losers slashed)
- No-votes scenario: fair proportional refunds
- Tie scenario: explicit handling with refunds

## Conclusion

The test suite comprehensively validates all aspects of the SaySo prediction market protocol:

- **Functionality:** All core features work as designed
- **Security:** Attack vectors mitigated, access controls enforced
- **Mathematics:** LMSR implementation correct and bounded
- **Economics:** Incentives aligned, payouts fair
- **Edge Cases:** Boundaries and unusual scenarios handled gracefully

**Status: Production-ready with 100% test pass rate** (221/221 tests)
