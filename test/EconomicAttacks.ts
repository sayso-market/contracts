import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("Economic Attack Vectors", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, attacker] = await viem.getWalletClients();

  async function advanceTime(seconds: number) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine");
  }

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async function deployAll() {
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000",
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);

    await oracle.write.setFactory([factory.address]);

    const now = await getNow();
    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Fund users with USDC
    await usdc.write.mint([alice.account.address, USDC(10_000)]);
    await usdc.write.mint([bob.account.address, USDC(10_000)]);
    await usdc.write.mint([charlie.account.address, USDC(10_000)]);
    await usdc.write.mint([attacker.account.address, USDC(10_000)]);

    // Create market with balanced 100 USDC seed
    await usdc.write.mint([deployer.account.address, USDC(100)]);
    await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
    await factory.write.createMarket(
      [
        "Test Market",
        effectiveFrom,
        effectiveTo,
        resolutionOpen,
        resolutionClose,
        USDC(50),
        USDC(50),
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      ],
      { account: deployer.account }
    );

    const markets = await factory.read.getMarkets([0n, 1n]);
    const market = await viem.getContractAt("AMM", markets[0]);

    return { usdc, sayso, factory, oracle, market };
  }

  describe("Sandwich Attacks", function () {
    it("should detect price manipulation from front-running", async function () {
      const { usdc, market } = await deployAll();

      // Record initial price
      const initialPrice = await market.read.price();

      // Scenario: Alice wants to buy 50 USDC of YES
      // Attacker sees pending tx and front-runs with large NO purchase

      // Attacker front-runs with 200 USDC NO
      await usdc.write.approve([market.address, USDC(200)], { account: attacker.account });
      await market.write.buyNo([USDC(200)], { account: attacker.account });

      const priceAfterFrontRun = await market.read.price();

      // Alice's transaction executes (at worse price than expected)
      await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
      const aliceYesBefore = await market.read.yesBalances([alice.account.address]);
      await market.write.buyYes([USDC(50)], { account: alice.account });
      const aliceYesAfter = await market.read.yesBalances([alice.account.address]);
      const aliceYesShares = aliceYesAfter - aliceYesBefore;

      const priceAfterVictim = await market.read.price();

      // Attacker back-runs by selling NO shares
      const attackerNoShares = await market.read.noBalances([attacker.account.address]);
      const attackerBalanceBefore = await usdc.read.balanceOf([attacker.account.address]);

      // Wait for MIN_HOLD_BLOCKS (10 blocks)
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      await market.write.sellNo([attackerNoShares], { account: attacker.account });
      const attackerBalanceAfter = await usdc.read.balanceOf([attacker.account.address]);

      const attackerProfit = Number(attackerBalanceAfter - attackerBalanceBefore);
      const attackerCost = Number(USDC(200));

      console.log(`  Initial price: ${Number(initialPrice) / 1e16}%`);
      console.log(`  Price after front-run: ${Number(priceAfterFrontRun) / 1e16}%`);
      console.log(`  Price after victim: ${Number(priceAfterVictim) / 1e16}%`);
      console.log(`  Alice received: ${Number(aliceYesShares) / 1e18} YES shares for 50 USDC`);
      console.log(`  Attacker spent: ${attackerCost / 1e6} USDC`);
      console.log(`  Attacker received: ${attackerProfit / 1e6} USDC`);
      console.log(`  Attacker net profit: ${(attackerProfit - attackerCost) / 1e6} USDC`);

      // Verify attack dynamics (not necessarily profitable due to fees + slippage)
      assert.ok(priceAfterFrontRun < initialPrice, "Front-run should decrease YES price");
      assert.ok(priceAfterVictim > priceAfterFrontRun, "Victim trade should increase YES price");

      // Key insight: Attacker's profit should be limited by LMSR slippage + fees
      // In a well-designed AMM, sandwich attacks should not be profitable
      const netProfit = (attackerProfit - attackerCost) / 1e6;
      console.log(`  → Sandwich attack ${netProfit > 0 ? 'PROFITABLE' : 'NOT profitable'} (${netProfit.toFixed(2)} USDC)`);
    });

    it("should limit sandwich attack profitability via fees and slippage", async function () {
      const { usdc, market } = await deployAll();

      // Attacker attempts sandwich with optimal timing
      await usdc.write.approve([market.address, USDC(500)], { account: attacker.account });
      const attackerBalanceBefore = await usdc.read.balanceOf([attacker.account.address]);

      // Front-run: Buy NO heavily
      await market.write.buyNo([USDC(500)], { account: attacker.account });
      const attackerNoShares = await market.read.noBalances([attacker.account.address]);

      // Victim: Someone buys YES
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Back-run: Sell NO shares
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }
      await market.write.sellNo([attackerNoShares], { account: attacker.account });

      const attackerBalanceAfter = await usdc.read.balanceOf([attacker.account.address]);
      const attackerProfit = attackerBalanceAfter - attackerBalanceBefore;

      console.log(`  Attacker net result: ${Number(attackerProfit) / 1e6} USDC`);

      // LMSR slippage + 0.5% fees should make this unprofitable or marginally profitable
      // Accept small profit due to MEV but verify it's not excessive
      const profitRatio = Number(attackerProfit) / Number(USDC(500));
      assert.ok(profitRatio < 0.05, "Sandwich profit should be < 5% (limited by slippage + fees)");
    });
  });

  describe("Arbitrage Exploits", function () {
    it("should prevent risk-free arbitrage between YES and NO sides", async function () {
      const { usdc, market } = await deployAll();

      // Create imbalance: Buy YES to push price to 80%
      await usdc.write.approve([market.address, USDC(150)], { account: alice.account });
      await market.write.buyYes([USDC(150)], { account: alice.account });

      const priceAfter = await market.read.price();
      console.log(`  YES price after Alice: ${Number(priceAfter) / 1e16}%`);

      // Attacker attempts arbitrage: Buy NO (cheap), sell immediately
      await usdc.write.approve([market.address, USDC(100)], { account: attacker.account });
      const attackerBalanceBefore = await usdc.read.balanceOf([attacker.account.address]);

      await market.write.buyNo([USDC(100)], { account: attacker.account });
      const attackerNoShares = await market.read.noBalances([attacker.account.address]);

      // Wait for MIN_HOLD_BLOCKS
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      await market.write.sellNo([attackerNoShares], { account: attacker.account });
      const attackerBalanceAfter = await usdc.read.balanceOf([attacker.account.address]);

      const profit = attackerBalanceAfter - attackerBalanceBefore;
      console.log(`  Attacker profit from arbitrage: ${Number(profit) / 1e6} USDC`);

      // LMSR should prevent risk-free arbitrage (buy+sell same side should lose money to fees)
      assert.ok(profit <= 0n, "Same-side buy→sell should not be profitable (fees + slippage)");
    });

    it("should prevent cross-side arbitrage (buying both YES and NO)", async function () {
      const { usdc, market } = await deployAll();

      // Attacker buys both sides to exploit pricing inefficiency
      await usdc.write.approve([market.address, USDC(200)], { account: attacker.account });
      const attackerBalanceBefore = await usdc.read.balanceOf([attacker.account.address]);

      // Buy 100 YES + 100 NO
      await market.write.buyYes([USDC(100)], { account: attacker.account });
      await market.write.buyNo([USDC(100)], { account: attacker.account });

      const yesShares = await market.read.yesBalances([attacker.account.address]);
      const noShares = await market.read.noBalances([attacker.account.address]);

      // Wait for MIN_HOLD_BLOCKS
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      // Sell both sides
      await market.write.sellYes([yesShares], { account: attacker.account });
      await market.write.sellNo([noShares], { account: attacker.account });

      const attackerBalanceAfter = await usdc.read.balanceOf([attacker.account.address]);
      const profit = attackerBalanceAfter - attackerBalanceBefore;

      console.log(`  Cross-side arbitrage profit: ${Number(profit) / 1e6} USDC`);
      console.log(`  Expected loss: ~2 USDC (1% total fees on 200 USDC)`);

      // Buying and selling both sides should lose money to fees (2 * 0.5% = 1%)
      assert.ok(profit < 0n, "Cross-side arbitrage should be unprofitable due to fees");
      assert.ok(profit >= -USDC(2.1), "Loss should be approximately fees (1% of 200 = 2 USDC)");
    });
  });

  describe("Liquidity Attacks", function () {
    it("should prevent liquidity drainage via repeated trades", async function () {
      const { usdc, market } = await deployAll();

      // Attacker attempts to drain liquidity by repeatedly buying and selling
      await usdc.write.approve([market.address, USDC(5_000)], { account: attacker.account });
      const attackerBalanceBefore = await usdc.read.balanceOf([attacker.account.address]);
      const poolBalanceBefore = await market.read.totalDeposited();

      // Perform 10 rounds of buy → wait → sell
      for (let round = 0; round < 10; round++) {
        // Buy YES
        await market.write.buyYes([USDC(50)], { account: attacker.account });

        // Wait MIN_HOLD_BLOCKS
        for (let i = 0; i < 10; i++) {
          await provider.send("evm_mine");
        }

        // Sell all YES shares
        const yesShares = await market.read.yesBalances([attacker.account.address]);
        if (yesShares > 0n) {
          await market.write.sellYes([yesShares], { account: attacker.account });
        }
      }

      const attackerBalanceAfter = await usdc.read.balanceOf([attacker.account.address]);
      const poolBalanceAfter = await market.read.totalDeposited();

      const attackerLoss = attackerBalanceBefore - attackerBalanceAfter;
      const poolGain = poolBalanceAfter - poolBalanceBefore;

      console.log(`  Attacker spent: ${Number(attackerLoss) / 1e6} USDC over 10 rounds`);
      console.log(`  Pool gained: ${Number(poolGain) / 1e6} USDC (fees collected)`);
      console.log(`  Pool liquidity before: ${Number(poolBalanceBefore) / 1e6} USDC`);
      console.log(`  Pool liquidity after: ${Number(poolBalanceAfter) / 1e6} USDC`);

      // Pool should gain from fees, not lose liquidity
      assert.ok(poolBalanceAfter >= poolBalanceBefore, "Pool should not lose liquidity");
      assert.ok(attackerBalanceAfter <= attackerBalanceBefore, "Attacker should lose money to fees");

      // Verify attacker lost money (fees + slippage over 10 rounds)
      // Buy fees: 10 rounds * 50 USDC * 0.5% = 2.5 USDC in fees alone
      const actualLoss = Number(attackerLoss);
      assert.ok(actualLoss > 0, "Attacker should lose money over repeated trades");
    });

    it("should handle extreme imbalance without pool death spiral", async function () {
      const { usdc, market } = await deployAll();

      // Create extreme imbalance: Buy YES with 90% of capital
      await usdc.write.approve([market.address, USDC(450)], { account: alice.account });
      await market.write.buyYes([USDC(450)], { account: alice.account });

      const priceAfterExtreme = await market.read.price();
      const qYes = await market.read.qYes();
      const qNo = await market.read.qNo();

      console.log(`  YES price after extreme buy: ${Number(priceAfterExtreme) / 1e16}%`);
      console.log(`  qYes: ${Number(qYes) / 1e18}, qNo: ${Number(qNo) / 1e18}`);
      console.log(`  Imbalance ratio: ${Number(qYes) / Number(qNo)}`);

      // Verify market still functions
      assert.ok(priceAfterExtreme <= 1e18, "Price should remain ≤ 100%");
      assert.ok(priceAfterExtreme >= 0n, "Price should remain ≥ 0%");

      // Attacker tries to buy NO (the cheap side)
      await usdc.write.approve([market.address, USDC(100)], { account: attacker.account });
      await market.write.buyNo([USDC(100)], { account: attacker.account });

      const priceAfterNo = await market.read.price();
      console.log(`  YES price after NO purchase: ${Number(priceAfterNo) / 1e16}%`);

      // Price should decrease but remain valid
      assert.ok(priceAfterNo < priceAfterExtreme, "NO purchase should decrease YES price");
      assert.ok(priceAfterNo >= 0n, "Price should remain valid");
    });
  });

  describe("Market Manipulation", function () {
    it("should detect seed share manipulation at market launch", async function () {
      const { usdc, factory, oracle, forwarder } = await deployAll();

      const now = await getNow();

      // Attacker creates market with manipulated seed (90% YES, 10% NO)
      await usdc.write.mint([attacker.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: attacker.account });
      await factory.write.createMarket(
        [
          "Manipulated Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(90), // 90% YES seed
          USDC(10), // 10% NO seed
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: attacker.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const manipulatedMarket = await viem.getContractAt("AMM", markets[markets.length - 1]);

      const initialPrice = await manipulatedMarket.read.price();
      const attackerYesShares = await manipulatedMarket.read.yesBalances([attacker.account.address]);
      const attackerNoShares = await manipulatedMarket.read.noBalances([attacker.account.address]);

      console.log(`  Initial price (manipulated): ${Number(initialPrice) / 1e16}%`);
      console.log(`  Attacker's YES shares: ${Number(attackerYesShares) / 1e18}`);
      console.log(`  Attacker's NO shares: ${Number(attackerNoShares) / 1e18}`);

      // Victim sees high YES price and buys NO (thinking it's cheap)
      await usdc.write.approve([manipulatedMarket.address, USDC(100)], { account: bob.account });
      await manipulatedMarket.write.buyNo([USDC(100)], { account: bob.account });

      const priceAfterVictim = await manipulatedMarket.read.price();
      console.log(`  Price after victim buys NO: ${Number(priceAfterVictim) / 1e16}%`);

      // Verify: Attacker received seed shares corresponding to their seed amounts
      // Seed provider (attacker) gets shares, not factory
      assert.ok(attackerYesShares > 0n, "Attacker should receive YES seed shares");
      assert.ok(attackerNoShares > 0n, "Attacker should receive NO seed shares");

      // The manipulated initial price is detectable and expected behavior
      // Users should verify seed distribution before trading
      assert.ok(initialPrice > 5e17, "Manipulated YES-heavy seed creates high initial price");
    });

    it("should handle coordinated voting attack (all voters vote wrong)", async function () {
      const { usdc, sayso, market, oracle } = await deployAll();

      // Trade phase: Alice buys YES, Bob buys NO
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
      await market.write.buyNo([USDC(100)], { account: bob.account });

      // Advance to voting period
      await advanceTime(301);

      // Coordinated attack: All voters (Charlie, Attacker) vote NO even though YES should win
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);
      await sayso.write.mint([attacker.account.address, SAYSO(1000)]);

      await sayso.write.approve([oracle.address, SAYSO(1000)], { account: charlie.account });
      await oracle.write.voteNo([market.address, SAYSO(1000)], { account: charlie.account });

      await sayso.write.approve([oracle.address, SAYSO(1000)], { account: attacker.account });
      await oracle.write.voteNo([market.address, SAYSO(1000)], { account: attacker.account });

      const yesVotes = await oracle.read.yesVotesTotal([market.address]);
      const noVotes = await oracle.read.noVotesTotal([market.address]);

      console.log(`  YES votes: ${Number(yesVotes) / 1e18} SAYSO`);
      console.log(`  NO votes: ${Number(noVotes) / 1e18} SAYSO`);

      // Advance to resolution
      await advanceTime(201);
      await market.write.resolve();

      const outcome = await market.read.outcome();
      console.log(`  Market resolved: ${outcome ? 'YES' : 'NO'} wins`);

      // Verify: NO wins despite potentially being "wrong" - oracle voting is final
      assert.equal(outcome, false, "NO should win (voters decided)");

      // Alice (YES bettor) loses
      const aliceClaimable = await market.read.calculateClaim([alice.account.address]);
      console.log(`  Alice (YES bettor) can claim: ${Number(aliceClaimable) / 1e6} USDC`);
      assert.equal(aliceClaimable, 0n, "Alice should get nothing (wrong side)");

      // Bob (NO bettor) wins
      const bobClaimable = await market.read.calculateClaim([bob.account.address]);
      console.log(`  Bob (NO bettor) can claim: ${Number(bobClaimable) / 1e6} USDC`);
      assert.ok(bobClaimable > USDC(100), "Bob should profit (correct side)");

      // This demonstrates the oracle governance model working as intended
      // Voters have final say, even if they collude or are wrong
    });
  });
});
