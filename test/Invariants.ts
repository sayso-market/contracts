import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

/**
 * PRIORITY 1: CRITICAL INVARIANTS
 * Tests that verify fundamental conservation laws and prevent loss of funds
 */
describe("Critical Invariants", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie] = await viem.getWalletClients();

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async function advanceTime(seconds: number | bigint) {
    const sec = typeof seconds === 'bigint' ? Number(seconds) : seconds;
    await provider.send("evm_increaseTime", [sec]);
    await provider.send("evm_mine");
  }

  async function mineBlocks(count: number) {
    for (let i = 0; i < count; i++) {
      await provider.send("evm_mine");
    }
  }

  async function deployInfrastructure() {
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

    return { usdc, sayso, oracle, forwarder, factory };
  }

  async function createMarket(
    factory: any,
    usdc: any,
    seedYes: bigint,
    seedNo: bigint
  ) {
    const now = await getNow();
    const totalSeed = seedYes + seedNo;

    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Test Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      seedYes,
      seedNo,
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    return viem.getContractAt("AMM", marketAddress);
  }

  describe("Conservation Laws", function () {
    it("pool balance + fees = totalDeposited + seed (after trades)", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));
      const seedAmount = USDC(10);

      // Fund users
      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await usdc.write.mint([bob.account.address, USDC(1000)]);

      await advanceTime(2);

      // Track initial state
      const feeCollectorBefore = await usdc.read.balanceOf([FEE_COLLECTOR]);

      // Alice buys 100 USDC YES
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Bob buys 200 USDC NO
      await usdc.write.approve([market.address, USDC(200)], { account: bob.account });
      await market.write.buyNo([USDC(200)], { account: bob.account });

      // Check conservation law
      const poolBalance = await usdc.read.balanceOf([market.address]);
      const feeCollectorAfter = await usdc.read.balanceOf([FEE_COLLECTOR]);
      const totalDeposited = await market.read.totalDeposited();
      const feesCollected = feeCollectorAfter - feeCollectorBefore;

      // Internal accounting: poolBalance should match totalDeposited
      assert.equal(
        poolBalance,
        totalDeposited,
        "Pool balance should equal totalDeposited (internal accounting)"
      );

      // Verify fees were collected correctly (0.5% of gross)
      const expectedFees = (USDC(100) + USDC(200)) * 5n / 1000n; // 0.5% of 300 = 1.5
      assert.equal(feesCollected, expectedFees, "Fees should be 0.5% of gross deposits");

      // Verify: totalDeposited = seed + netDeposits (after fees)
      const expectedDeposits = seedAmount + USDC(100) * 995n / 1000n + USDC(200) * 995n / 1000n;
      assert.equal(totalDeposited, expectedDeposits, "totalDeposited should match seed + net deposits");
    });

    it("share accounting: totalYes/totalNo = sum of user balances", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await usdc.write.mint([bob.account.address, USDC(1000)]);
      await usdc.write.mint([charlie.account.address, USDC(1000)]);

      await advanceTime(2);

      // Multiple users buy
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(150)], { account: bob.account });
      await market.write.buyYes([USDC(150)], { account: bob.account });

      await usdc.write.approve([market.address, USDC(200)], { account: charlie.account });
      await market.write.buyNo([USDC(200)], { account: charlie.account });

      // Get contract totals
      const info = await market.read.getMarketInfo();
      const totalYes = info[2];
      const totalNo = info[3];

      // Sum user balances
      const aliceYes = await market.read.yesBalances([alice.account.address]);
      const bobYes = await market.read.yesBalances([bob.account.address]);
      const charlieNo = await market.read.noBalances([charlie.account.address]);
      const deployerYes = await market.read.yesBalances([deployer.account.address]); // Seed shares
      const deployerNo = await market.read.noBalances([deployer.account.address]);

      const sumYes = aliceYes + bobYes + deployerYes;
      const sumNo = charlieNo + deployerNo;

      assert.equal(totalYes, sumYes, "totalYes should equal sum of user YES balances");
      assert.equal(totalNo, sumNo, "totalNo should equal sum of user NO balances");
    });

    it("after all claims, pool is fully drained or only unclaimed seed remains", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));
      const marketAddress = await market.address;

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await usdc.write.mint([bob.account.address, USDC(1000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);

      await advanceTime(2);

      // Trading
      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(300)], { account: bob.account });
      await market.write.buyNo([USDC(300)], { account: bob.account });

      // Voting
      const now = await getNow();
      await advanceTime((await market.read.resolutionOpen()) - BigInt(now) + 1n);

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      // Resolution
      const now2 = await getNow();
      await advanceTime((await market.read.resolutionClose()) - BigInt(now2) + 1n);
      await market.write.resolve();

      // Claims
      await market.write.claim({ account: alice.account });

      const poolAfterClaims = await usdc.read.balanceOf([market.address]);

      // Pool should have at most the unclaimed seed (deployer's shares)
      // Deployer provided 10 USDC seed, should have ~7-8 USDC of unclaimed shares
      assert.ok(
        poolAfterClaims <= USDC(10),
        `Pool should have ≤10 USDC (unclaimed seed), got ${poolAfterClaims}`
      );
    });

    it("LMSR: qYes + qNo represents total outstanding shares", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      const info1 = await market.read.getMarketInfo();
      const qYesBefore = info1[4];
      const qNoBefore = info1[5];

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const info2 = await market.read.getMarketInfo();
      const qYesAfter = info2[4];
      const qNoAfter = info2[5];
      const totalYes = info2[2];
      const totalNo = info2[3];

      // qYes should have increased by the shares Alice received
      assert.ok(qYesAfter > qYesBefore, "qYes should increase after buying");

      // qYes/qNo include virtual liquidity from initial amplification, so qYes >= totalYes
      assert.ok(qYesAfter >= totalYes, "qYes should be >= totalYes (includes virtual liquidity)");
      assert.ok(qNoAfter >= totalNo, "qNo should be >= totalNo (includes virtual liquidity)");
    });
  });

  describe("Internal Accounting", function () {
    it("donation attack: direct USDC transfer doesn't affect calculateClaim", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));
      const marketAddress = await market.address;

      await usdc.write.mint([alice.account.address, USDC(2000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);

      await advanceTime(2);

      // Alice bets
      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      // Voting
      const now = await getNow();
      await advanceTime((await market.read.resolutionOpen()) - BigInt(now) + 1n);

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      // Resolution
      const now2 = await getNow();
      await advanceTime((await market.read.resolutionClose()) - BigInt(now2) + 1n);
      await market.write.resolve();

      // Calculate claim BEFORE donation
      const claimBefore = await market.read.calculateClaim([alice.account.address]);

      // DONATION ATTACK: Send 1000 USDC directly to pool
      await usdc.write.transfer([market.address, USDC(1000)], { account: alice.account });

      // Verify pool balance increased
      const poolBalance = await usdc.read.balanceOf([market.address]);
      assert.ok(poolBalance > USDC(1000), "Pool should have received donation");

      // Calculate claim AFTER donation - should be UNCHANGED
      const claimAfter = await market.read.calculateClaim([alice.account.address]);

      assert.equal(
        claimAfter,
        claimBefore,
        "Claim should NOT change after donation (internal accounting)"
      );

      // Verify claim actually works
      const aliceBalanceBefore = await usdc.read.balanceOf([alice.account.address]);
      await market.write.claim({ account: alice.account });
      const aliceBalanceAfter = await usdc.read.balanceOf([alice.account.address]);

      // Alice should receive exactly claimBefore amount (not inflated by donation)
      const actualPayout = aliceBalanceAfter - aliceBalanceBefore;
      assert.equal(
        actualPayout,
        claimBefore,
        "Alice should receive exactly her claim (not inflated by donation)"
      );
    });

    it("donation attack: resolve uses totalDeposited, not balanceOf", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));
      const marketAddress = await market.address;

      await usdc.write.mint([alice.account.address, USDC(2000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);

      await advanceTime(2);

      // Trading
      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      const totalDepositedBefore = await market.read.totalDeposited();

      // DONATION ATTACK: Send USDC before resolution
      await usdc.write.transfer([market.address, USDC(1000)], { account: alice.account });

      const poolBalanceBeforeResolve = await usdc.read.balanceOf([market.address]);
      assert.ok(
        poolBalanceBeforeResolve > totalDepositedBefore,
        "Pool balanceOf should include donation"
      );

      // Voting
      const now = await getNow();
      await advanceTime((await market.read.resolutionOpen()) - BigInt(now) + 1n);

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      // Resolution
      const now2 = await getNow();
      await advanceTime((await market.read.resolutionClose()) - BigInt(now2) + 1n);
      await market.write.resolve();

      // Verify resolvedPoolBalance equals totalDeposited (NOT balanceOf)
      const resolvedPoolBalance = await market.read.resolvedPoolBalance();
      const totalDepositedAfter = await market.read.totalDeposited();

      assert.equal(
        resolvedPoolBalance,
        totalDepositedAfter,
        "resolvedPoolBalance should equal totalDeposited (internal accounting)"
      );

      assert.ok(
        resolvedPoolBalance < poolBalanceBeforeResolve,
        "resolvedPoolBalance should ignore donation"
      );
    });

    it("totalDeposited tracks buy/sell correctly", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));
      const seedAmount = USDC(10);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      let totalDeposited = await market.read.totalDeposited();
      assert.equal(totalDeposited, seedAmount, "Initial totalDeposited should equal seed");

      // Buy 100 USDC YES (net 99.5 after 0.5% fee)
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      totalDeposited = await market.read.totalDeposited();
      const expectedAfterBuy = seedAmount + USDC(100) * 995n / 1000n;
      assert.equal(
        totalDeposited,
        expectedAfterBuy,
        "totalDeposited should increase by net amount after buy"
      );

      // Sell shares
      await mineBlocks(10);
      const shares = await market.read.yesBalances([alice.account.address]);
      await market.write.sellYes([shares / 2n], { account: alice.account });

      const totalDepositedAfterSell = await market.read.totalDeposited();
      assert.ok(
        totalDepositedAfterSell < totalDeposited,
        "totalDeposited should decrease after sell"
      );
    });
  });

  describe("LMSR Price Bounds in Integration", function () {
    it("price remains in [0, 100%] during extreme trades", async function () {
      const { usdc, factory } = await deployInfrastructure();
      // Use larger seed to allow bigger trades without overflow
      const market = await createMarket(factory, usdc, USDC(50), USDC(50));

      await usdc.write.mint([alice.account.address, USDC(10000)]);
      await advanceTime(2);

      // Check initial price
      let price = await market.read.price();
      assert.ok(price >= 0n && price <= 1000000000000000000n, "Initial price in bounds");

      // Large YES purchase (50x pool size, but not 500x)
      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      price = await market.read.price();
      assert.ok(
        price >= 0n && price <= 1000000000000000000n,
        `Price after large YES buy should be in [0,100%], got ${price}`
      );
      assert.ok(price > 550000000000000000n, "Price should be elevated after large YES buy");

      // Large NO purchase to balance
      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyNo([USDC(500)], { account: alice.account });

      price = await market.read.price();
      assert.ok(
        price >= 0n && price <= 1000000000000000000n,
        `Price after extreme NO buy should be in [0,100%], got ${price}`
      );
    });

    it("buying YES always increases or maintains price", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));

      await usdc.write.mint([alice.account.address, USDC(10000)]);
      await advanceTime(2);

      let prevPrice = await market.read.price();

      // Buy YES multiple times
      for (let i = 0; i < 5; i++) {
        await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
        await market.write.buyYes([USDC(100)], { account: alice.account });

        const newPrice = await market.read.price();
        assert.ok(
          newPrice >= prevPrice,
          `Price should increase or stay same after YES buy (iteration ${i})`
        );
        prevPrice = newPrice;
      }
    });

    it("selling YES always decreases or maintains price", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const market = await createMarket(factory, usdc, USDC(5), USDC(5));

      await usdc.write.mint([alice.account.address, USDC(10000)]);
      await advanceTime(2);

      // Buy to get shares
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      await mineBlocks(10);

      let prevPrice = await market.read.price();
      const shares = await market.read.yesBalances([alice.account.address]);

      // Sell in chunks
      for (let i = 0; i < 5; i++) {
        await market.write.sellYes([shares / 10n], { account: alice.account });

        const newPrice = await market.read.price();
        assert.ok(
          newPrice <= prevPrice,
          `Price should decrease or stay same after YES sell (iteration ${i})`
        );
        prevPrice = newPrice;
      }
    });
  });
});
