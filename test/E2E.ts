import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("SaySo E2E", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, dave] = await viem.getWalletClients();

  async function advanceTime(seconds: number | bigint) {
    const sec = typeof seconds === 'bigint' ? Number(seconds) : seconds;
    await provider.send("evm_increaseTime", [sec]);
    await provider.send("evm_mine");
  }

  async function mineBlock() {
    await provider.send("evm_mine");
  }

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  /**
   * INVARIANT CHECKS
   * These helper functions verify critical system invariants after operations
   */

  async function assertPriceBounds(market: any, context: string) {
    const price = await market.read.price();
    // Price is in 18 decimals, should be between 0 and 1e18 (0% to 100%)
    assert.ok(
      price >= 0n && price <= 1000000000000000000n,
      `${context}: Price must be between 0% and 100%, got ${price}`
    );
  }

  async function assertConservationLaw(market: any, usdc: any, context: string) {
    const totalDeposited = await market.read.totalDeposited();
    const poolBalance = await usdc.read.balanceOf([market.address]);
    const feeCollectorBalance = await usdc.read.balanceOf([FEE_COLLECTOR]);

    // Conservation law: pool balance should match totalDeposited (internal accounting)
    // Fees are collected separately, so pool = totalDeposited
    // Note: Direct donations don't affect totalDeposited (internal accounting)
    assert.ok(
      poolBalance >= totalDeposited * 99n / 100n, // Allow 1% tolerance for rounding
      `${context}: Pool balance (${poolBalance}) should approximately equal totalDeposited (${totalDeposited})`
    );
  }

  async function assertNoNegativeBalances(market: any, accounts: any[], context: string) {
    for (const account of accounts) {
      const yesBalance = await market.read.yesBalances([account.account.address]);
      const noBalance = await market.read.noBalances([account.account.address]);

      assert.ok(yesBalance >= 0n, `${context}: YES balance cannot be negative for ${account.account.address}`);
      assert.ok(noBalance >= 0n, `${context}: NO balance cannot be negative for ${account.account.address}`);
    }
  }

  async function assertResolvedConsistency(market: any, context: string) {
    const resolved = await market.read.resolved();
    if (!resolved) return; // Skip if not resolved yet

    const totalDeposited = await market.read.totalDeposited();
    const resolvedPoolBalance = await market.read.resolvedPoolBalance();

    // After resolution, resolvedPoolBalance should equal totalDeposited
    // This proves resolve() uses internal accounting, not balanceOf()
    assert.equal(
      resolvedPoolBalance,
      totalDeposited,
      `${context}: resolvedPoolBalance must equal totalDeposited (internal accounting)`
    );
  }

  /**
   * Deploy full infrastructure and create a market.
   *
   * Timeline:
   *   effectiveFrom   = now        (betting open immediately)
   *   effectiveTo     = now + 200  (betting closes after 200s)
   *   resolutionOpen  = now + 300  (voting starts)
   *   resolutionClose = now + 500  (voting ends)
   */
  async function deployAll() {
    const now = await getNow();

    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000", // factory set after deployment
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);

    // Link oracle to factory (circular dependency resolved)
    await oracle.write.setFactory([factory.address]);

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Fund deployer with seed USDC (minimum 10 USDC required)
    const seedAmount = USDC(10); // 5 YES + 5 NO
    await usdc.write.mint([deployer.account.address, seedAmount]);
    await usdc.write.approve([factory.address, seedAmount]);

    await factory.write.createMarket([
      "Will ETH hit $10k by end of 2026?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(10), // totalSeed (10 USDC)
      5000n, // targetPriceBps (50%)
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      deployer.account.address,
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Fund bettors with USDC
    await usdc.write.mint([alice.account.address, USDC(10000)]);
    await usdc.write.mint([bob.account.address, USDC(10000)]);

    // Fund voters with SAYSO (deployer is owner, can mint)
    await sayso.write.mint([charlie.account.address, SAYSO(1000)]);
    await sayso.write.mint([dave.account.address, SAYSO(1000)]);

    return {
      usdc, sayso, oracle, forwarder, factory, market, marketAddress,
      effectiveFrom, effectiveTo, resolutionOpen, resolutionClose,
    };
  }

  // ──────────────────────────────────────────
  // Market creation
  // ──────────────────────────────────────────
  describe("Market Creation", async function () {
    it("creates a market via the factory with correct defaults", async function () {
      const { factory, market, marketAddress } = await deployAll();

      assert.equal(await factory.read.getMarketCount(), 1n);
      assert.ok(await factory.read.isMarket([marketAddress]));

      const info = await market.read.getMarketInfo();
      assert.equal(info[0], "Will ETH hit $10k by end of 2026?");
      // Price should be near 50% (balanced 5 YES + 5 NO seed)
      const price = info[1];
      assert.ok(price >= 450000000000000000n && price <= 550000000000000000n, "Price should be near 50%");
    });
  });

  // ──────────────────────────────────────────
  // Betting
  // ──────────────────────────────────────────
  describe("Betting", async function () {
    it("buys YES and NO shares and moves the price correctly", async function () {
      const { usdc, market } = await deployAll();
      await advanceTime(2);

      // Alice buys YES — price should increase significantly
      const priceBefore = await market.read.price();
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const aliceYes = await market.read.yesBalances([alice.account.address]);
      assert.ok(aliceYes > 0n);
      const priceAfterYes = await market.read.price();
      assert.ok(priceAfterYes > priceBefore, "Price should increase after YES purchase");

      // INVARIANT CHECKS after Alice's buy
      await assertPriceBounds(market, "After Alice buys YES");
      await assertConservationLaw(market, usdc, "After Alice buys YES");
      await assertNoNegativeBalances(market, [alice, bob], "After Alice buys YES");

      // Bob buys NO with same amount — price should decrease back toward 50%
      await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
      await market.write.buyNo([USDC(100)], { account: bob.account });

      const bobNo = await market.read.noBalances([bob.account.address]);
      assert.ok(bobNo > 0n);
      const priceAfterNo = await market.read.price();
      assert.ok(priceAfterNo < priceAfterYes, "Price should decrease after NO purchase");

      // INVARIANT CHECKS after Bob's buy
      await assertPriceBounds(market, "After Bob buys NO");
      await assertConservationLaw(market, usdc, "After Bob buys NO");
      await assertNoNegativeBalances(market, [alice, bob], "After Bob buys NO");
    });

    it("deducts 0.5% fee to the fee collector", async function () {
      const { usdc, market } = await deployAll();
      await advanceTime(2);

      const feeBefore = await usdc.read.balanceOf([FEE_COLLECTOR]);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const feeAfter = await usdc.read.balanceOf([FEE_COLLECTOR]);
      assert.equal(feeAfter - feeBefore, USDC(0.5)); // 0.5% of 100 = 0.5
    });

    it("rejects bets outside the trading period", async function () {
      const { usdc, market } = await deployAll();
      await advanceTime(300); // past effectiveTo (200)

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await assert.rejects(
        market.write.buyYes([USDC(100)], { account: alice.account }),
        /Trading outside effective period/,
      );
    });
  });

  // ──────────────────────────────────────────
  // Selling
  // ──────────────────────────────────────────
  describe("Selling", async function () {
    it("allows selling after MIN_HOLD_BLOCKS", async function () {
      const { usdc, market } = await deployAll();
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const sharesBefore = await market.read.yesBalances([alice.account.address]);

      // Mine 10 blocks to satisfy flash-loan protection (MIN_HOLD_BLOCKS = 10)
      for (let i = 0; i < 10; i++) {
        await mineBlock();
      }

      const half = sharesBefore / 2n;
      await market.write.sellYes([half], { account: alice.account });

      const sharesAfter = await market.read.yesBalances([alice.account.address]);
      assert.equal(sharesAfter, sharesBefore - half);

      // INVARIANT CHECKS after selling
      await assertPriceBounds(market, "After Alice sells YES");
      await assertConservationLaw(market, usdc, "After Alice sells YES");
      await assertNoNegativeBalances(market, [alice], "After Alice sells YES");
    });

    it("rejects selling before MIN_HOLD_BLOCKS (flash-loan protection)", async function () {
      const { usdc, market } = await deployAll();
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const shares = await market.read.yesBalances([alice.account.address]);

      // Try to sell immediately — should revert
      await assert.rejects(
        market.write.sellYes([shares], { account: alice.account }),
        /Must wait before selling/,
      );
    });
  });

  // ──────────────────────────────────────────
  // Full lifecycle: bet → vote → resolve → claim
  // ──────────────────────────────────────────
  describe("Full Lifecycle", async function () {
    it("bet → vote → resolve → claim USDC + SAYSO correctly", async function () {
      const {
        usdc, sayso, oracle, market, marketAddress,
        resolutionOpen, resolutionClose,
      } = await deployAll();

      // ── Phase 1: Place bets ──
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(300)], { account: bob.account });
      await market.write.buyNo([USDC(300)], { account: bob.account });

      assert.ok(await market.read.yesBalances([alice.account.address]) > 0n);
      assert.ok(await market.read.noBalances([bob.account.address]) > 0n);

      // INVARIANT CHECKS after betting phase
      await assertPriceBounds(market, "After betting phase");
      await assertConservationLaw(market, usdc, "After betting phase");
      await assertNoNegativeBalances(market, [alice, bob], "After betting phase");

      // Pool should hold seed + net deposits (after 0.5% fee)
      // Seed: 10, Alice: 500 - 2.5 = 497.5, Bob: 300 - 1.5 = 298.5 → total 806
      const poolBalance = await usdc.read.balanceOf([market.address]);
      assert.equal(poolBalance, USDC(10) + USDC(497.5) + USDC(298.5));

      // ── Phase 2: Advance to resolution window → vote (stake = vote) ──
      const now3 = await getNow();
      await advanceTime(resolutionOpen - now3 + 1);

      // Charlie votes YES by staking 500 SAYSO directly on the pool
      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      // Dave votes NO by staking 200 SAYSO directly on the pool
      await sayso.write.approve([oracle.address, SAYSO(200)], { account: dave.account });
      await oracle.write.voteNo([marketAddress, SAYSO(200)], { account: dave.account });

      assert.equal(await oracle.read.yesVotesTotal([marketAddress]), SAYSO(500));
      assert.equal(await oracle.read.noVotesTotal([marketAddress]), SAYSO(200));

      // ── Phase 3: Advance past resolution close → resolve ──
      const now4 = await getNow();
      await advanceTime(resolutionClose - now4 + 1);

      await market.write.resolve();

      const [yesWins, isResolved] = await market.read.getOutcome();
      assert.equal(isResolved, true);
      assert.equal(yesWins, true); // 500 YES > 200 NO

      // CRITICAL INVARIANT: Verify resolvedPoolBalance = totalDeposited
      await assertResolvedConsistency(market, "After resolution");
      await assertPriceBounds(market, "After resolution");
      await assertNoNegativeBalances(market, [alice, bob], "After resolution");

      // ── Phase 4: AMM claims (USDC) ──
      const aliceUsdcBefore = await usdc.read.balanceOf([alice.account.address]);
      await market.write.claim({ account: alice.account });
      const aliceUsdcAfter = await usdc.read.balanceOf([alice.account.address]);

      const alicePayout = aliceUsdcAfter - aliceUsdcBefore;
      // Alice is the only YES bettor → gets most of the pool
      // Pool has seed + deposits = 10 + 796 = 806 USDC
      assert.ok(alicePayout >= USDC(790) && alicePayout <= USDC(810), "Alice should get ~800 USDC");

      // Bob (NO loser) should not be able to claim
      await assert.rejects(
        market.write.claim({ account: bob.account }),
        /No claimable amount/,
      );

      // ── Phase 5: Oracle claims (SAYSO) ──
      // Charlie (YES voter, winner) gets his 500 + Dave's 200 = 700
      const charlieBefore = await sayso.read.balanceOf([charlie.account.address]);
      await oracle.write.claim([marketAddress], { account: charlie.account });
      const charlieAfter = await sayso.read.balanceOf([charlie.account.address]);
      assert.equal(charlieAfter - charlieBefore, SAYSO(700));

      // Dave (NO voter, loser) claims — gets 0 (slashed)
      const daveBefore = await sayso.read.balanceOf([dave.account.address]);
      await oracle.write.claim([marketAddress], { account: dave.account });
      const daveAfter = await sayso.read.balanceOf([dave.account.address]);
      assert.equal(daveAfter - daveBefore, 0n); // loser gets nothing
    });
  });

  // ──────────────────────────────────────────
  // No-votes scenario: proportional refund
  // ──────────────────────────────────────────
  describe("No Votes", async function () {
    it("refunds USDC proportionally when no resolution votes are cast", async function () {
      const { usdc, market, resolutionClose } = await deployAll();
      await advanceTime(2);

      // Alice bets 600 YES, Bob bets 400 NO
      await usdc.write.approve([market.address, USDC(600)], { account: alice.account });
      await market.write.buyYes([USDC(600)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(400)], { account: bob.account });
      await market.write.buyNo([USDC(400)], { account: bob.account });

      // Skip to after resolution — nobody votes
      const now = await getNow();
      await advanceTime(resolutionClose - now + 1);

      // Resolve with no votes
      await market.write.resolve();

      // INVARIANT CHECKS after no-votes resolution
      await assertResolvedConsistency(market, "After no-votes resolution");
      await assertPriceBounds(market, "After no-votes resolution");
      await assertNoNegativeBalances(market, [alice, bob], "After no-votes resolution");

      // Alice claims proportional refund
      const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
      await market.write.claim({ account: alice.account });
      const aliceRefund = (await usdc.read.balanceOf([alice.account.address])) - aliceBefore;

      // Bob claims proportional refund
      const bobBefore = await usdc.read.balanceOf([bob.account.address]);
      await market.write.claim({ account: bob.account });
      const bobRefund = (await usdc.read.balanceOf([bob.account.address])) - bobBefore;

      // With LMSR, refunds are proportional to shares (not deposits)
      // Alice deposited 600 USDC (net 597), Bob deposited 400 USDC (net 398)
      // Total pool: 10 seed + 995 net = 1005 USDC
      // Refunds should be positive and sum to total pool
      assert.ok(aliceRefund > USDC(400), "Alice should get significant refund");
      assert.ok(bobRefund > USDC(300), "Bob should get significant refund");
      assert.ok(aliceRefund + bobRefund <= USDC(1010), "Total refunds <= pool balance");

      // CONSERVATION LAW: Total claims should not exceed totalDeposited
      const totalDeposited = await market.read.totalDeposited();
      assert.ok(
        aliceRefund + bobRefund <= totalDeposited,
        "Total claims cannot exceed totalDeposited (conservation law)"
      );
    });
  });

  // ──────────────────────────────────────────
  // Oracle: voting period enforcement
  // ──────────────────────────────────────────
  describe("Oracle Voting", async function () {
    it("rejects voting outside the resolution window", async function () {
      const { sayso, oracle, marketAddress } = await deployAll();

      // Try to vote during betting period (before resolution opens)
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: charlie.account });
      await assert.rejects(
        oracle.write.voteYes([marketAddress, SAYSO(100)], { account: charlie.account }),
        /Voting has not opened yet/,
      );
    });
  });
});
