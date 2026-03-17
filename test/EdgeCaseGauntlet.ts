/**
 * EDGE CASE GAUNTLET
 *
 * Tests boundary conditions and unusual scenarios:
 * - Timing boundaries (exact timestamps)
 * - Minimum/maximum values
 * - No-bet / no-vote scenarios
 * - Pause/unpause consistency
 * - Partial sells then resolution
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

describe("Edge Case Gauntlet", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, dave] = await viem.getWalletClients();

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async function advanceTime(seconds: number | bigint) {
    const sec = typeof seconds === "bigint" ? Number(seconds) : seconds;
    await provider.send("evm_increaseTime", [sec]);
    await provider.send("evm_mine");
  }

  async function mineBlocks(count: number) {
    for (let i = 0; i < count; i++) {
      await provider.send("evm_mine");
    }
  }

  async function deployFresh() {
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      ZERO_ADDRESS,
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);
    await oracle.write.setFactory([factory.address]);
    return { usdc, sayso, oracle, factory, forwarder };
  }

  // ════════════════════════════════════════════
  // (a) Buy before effectiveFrom
  // ════════════════════════════════════════════
  it("(a) Cannot buy before effectiveFrom", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    // Market starts 100s in the future
    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Future Market",
      BigInt(now + 100), // effectiveFrom in the future
      BigInt(now + 300),
      BigInt(now + 400),
      BigInt(now + 600),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });

    await assert.rejects(
      market.write.buyYes([USDC(50)], { account: alice.account }),
      (err: any) => {
        const msg = err.message || "";
        return msg.includes("Trading outside effective period");
      },
      "Cannot buy before effectiveFrom"
    );
  });

  // ════════════════════════════════════════════
  // (b) Buy near end of trading period still works
  // ════════════════════════════════════════════
  it("(b) Buy near end of trading period succeeds", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Boundary Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    // Advance to near (but not past) effectiveTo
    // Note: each transaction also advances timestamp by 1s in hardhat
    await advanceTime(190);

    await usdc.write.mint([alice.account.address, USDC(10)]);
    await usdc.write.approve([market.address, USDC(10)], { account: alice.account });

    // This should succeed — still within trading period
    await market.write.buyYes([USDC(10)], { account: alice.account });
    const shares = await market.read.yesBalances([alice.account.address]);
    assert.ok(shares > 0n, "Should get shares near end of trading period");
  });

  // ════════════════════════════════════════════
  // (c) Buy 1 second after effectiveTo (should fail)
  // ════════════════════════════════════════════
  it("(c) Buy after effectiveTo fails", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Past Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    // Advance past effectiveTo
    await advanceTime(201);

    await usdc.write.mint([alice.account.address, USDC(10)]);
    await usdc.write.approve([market.address, USDC(10)], { account: alice.account });

    await assert.rejects(
      market.write.buyYes([USDC(10)], { account: alice.account }),
      (err: any) => {
        const msg = err.message || "";
        return msg.includes("Trading outside effective period");
      },
      "Cannot buy after effectiveTo"
    );
  });

  // ════════════════════════════════════════════
  // (d) Minimum seed market with maximum bet pressure
  // ════════════════════════════════════════════
  it("(d) Minimum seed ($10) with substantial bets — no overflow", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Min Seed Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    await advanceTime(2);

    // Multiple bets up to 100x seed (but within LMSR limits)
    const bettors = [alice, bob, charlie, dave];
    for (let i = 0; i < bettors.length; i++) {
      await usdc.write.mint([bettors[i].account.address, USDC(200)]);
      await usdc.write.approve([market.address, USDC(200)], {
        account: bettors[i].account,
      });
      if (i % 2 === 0) {
        await market.write.buyYes([USDC(200)], { account: bettors[i].account });
      } else {
        await market.write.buyNo([USDC(200)], { account: bettors[i].account });
      }
    }

    // Verify state consistency
    const price = await market.read.price();
    assert.ok(price > 0n && price < 1000000000000000000n, "Price in bounds");

    const totalDeposited = await market.read.totalDeposited();
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(poolBalance >= totalDeposited, "Pool >= totalDeposited");
  });

  // ════════════════════════════════════════════
  // (e) Below MIN_DEPOSIT should revert
  // ════════════════════════════════════════════
  it("(e) 1 wei of USDC (below MIN_DEPOSIT) should revert", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Wei Test",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    await advanceTime(2);
    await usdc.write.mint([alice.account.address, 1n]);
    await usdc.write.approve([market.address, 1n], { account: alice.account });

    await assert.rejects(
      market.write.buyYes([1n], { account: alice.account }),
      (err: any) => err instanceof Error,
      "1 wei should be below MIN_DEPOSIT"
    );
  });

  // ════════════════════════════════════════════
  // (f) No bets, no votes — resolve handles gracefully
  // ════════════════════════════════════════════
  it("(f) No bets, no votes — resolve works, seed provider can claim", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Ghost Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      ZERO_ADDRESS, // voting market
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const marketAddress = markets[markets.length - 1];
    const market = await viem.getContractAt("AMM", marketAddress);

    // No bets, no votes, advance past resolution
    await advanceTime(501);

    // Resolve with no votes
    await market.write.resolve();
    const resolved = await market.read.resolved();
    assert.equal(resolved, true, "Market should be resolved");

    // Seed provider claims refund
    const before = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const after = await usdc.read.balanceOf([deployer.account.address]);

    // With no votes, refund is (yesShare + noShare) / 2
    // yesShare = 5e12 * 10e6 / 5e12 = 10e6
    // noShare = 5e12 * 10e6 / 5e12 = 10e6
    // claim = (10e6 + 10e6) / 2 = 10e6 = $10
    assert.equal(after - before, USDC(10), "Seed provider should get full refund");
  });

  // ════════════════════════════════════════════
  // (g) 1 person bets YES, no votes — resolve handles
  // ════════════════════════════════════════════
  it("(g) 1 person bets YES, no votes — proportional refund", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "One Bet Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      ZERO_ADDRESS,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const marketAddress = markets[markets.length - 1];
    const market = await viem.getContractAt("AMM", marketAddress);

    await advanceTime(2);
    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // No votes
    await advanceTime(500);
    await market.write.resolve();

    const resolvedPool = await market.read.resolvedPoolBalance();

    // Both deployer and alice claim
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const dClaim = (await usdc.read.balanceOf([deployer.account.address])) - dBefore;

    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    const aClaim = (await usdc.read.balanceOf([alice.account.address])) - aBefore;

    // Total claims should not exceed pool
    assert.ok(
      dClaim + aClaim <= resolvedPool,
      "Total claims should not exceed resolvedPoolBalance"
    );

    // Pool should be drained
    const remaining = await usdc.read.balanceOf([market.address]);
    assert.ok(remaining <= 1000000n, "Pool should be drained (< 1 USDC dust)");
  });

  // ════════════════════════════════════════════
  // (h) Sell during trading period after hold blocks
  // ════════════════════════════════════════════
  it("(h) Sell during trading period after hold blocks succeeds", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    // Use a long trading window so mining blocks doesn't push past it
    await factory.write.createMarket([
      "Sell Boundary",
      BigInt(now),
      BigInt(now + 10000),
      BigInt(now + 10100),
      BigInt(now + 10200),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    await advanceTime(2);
    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await mineBlocks(11);

    const shares = await market.read.yesBalances([alice.account.address]);
    await market.write.sellYes([shares / 2n], { account: alice.account });

    const sharesAfter = await market.read.yesBalances([alice.account.address]);
    assert.ok(sharesAfter < shares, "Should have fewer shares after selling");
  });

  // ════════════════════════════════════════════
  // (i) Sell after effectiveTo fails
  // ════════════════════════════════════════════
  it("(i) Sell after effectiveTo fails", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Sell After",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    await advanceTime(2);
    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Advance past effectiveTo
    await advanceTime(200);

    const shares = await market.read.yesBalances([alice.account.address]);
    await assert.rejects(
      market.write.sellYes([shares], { account: alice.account }),
      (err: any) => err instanceof Error,
      "Cannot sell after effectiveTo"
    );
  });

  // ════════════════════════════════════════════
  // (j) Voting market auto-resolves on first claim
  // ════════════════════════════════════════════
  it("(j) Voting market auto-resolves when claim() is called", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Auto Resolve",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      ZERO_ADDRESS,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const marketAddress = markets[markets.length - 1];
    const market = await viem.getContractAt("AMM", marketAddress);

    await advanceTime(2);
    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Vote
    await advanceTime(300);
    await sayso.write.mint([charlie.account.address, SAYSO(100)]);
    await sayso.write.approve([oracle.address, SAYSO(100)], { account: charlie.account });
    await oracle.write.voteYes([marketAddress, SAYSO(100)], { account: charlie.account });

    // Advance past resolution, but DON'T call resolve()
    await advanceTime(201);

    const resolvedBefore = await market.read.resolved();
    assert.equal(resolvedBefore, false, "Should not be resolved yet");

    // claim() should auto-resolve
    await market.write.claim({ account: alice.account });

    const resolvedAfter = await market.read.resolved();
    assert.equal(resolvedAfter, true, "Should be resolved after claim()");
  });

  // ════════════════════════════════════════════
  // (k) Exact MIN_DEPOSIT boundary
  // ════════════════════════════════════════════
  it("(k) Exactly MIN_DEPOSIT (1 USDC) succeeds", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await factory.write.createMarket([
      "Min Deposit Test",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeed,
      5000n,
      deployer.account.address,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

    await advanceTime(2);
    await usdc.write.mint([alice.account.address, USDC(1)]);
    await usdc.write.approve([market.address, USDC(1)], { account: alice.account });

    // Exactly 1 USDC = 1e6 = MIN_DEPOSIT, should succeed
    await market.write.buyYes([USDC(1)], { account: alice.account });
    const shares = await market.read.yesBalances([alice.account.address]);
    assert.ok(shares > 0n, "Should get shares at MIN_DEPOSIT");
  });

  // ════════════════════════════════════════════
  // (l) Invalid market timing params
  // ════════════════════════════════════════════
  it("(l) Market with effectiveFrom >= effectiveTo should revert", async function () {
    const { usdc, factory } = await deployFresh();
    const now = await getNow();

    const totalSeed = USDC(10);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    await assert.rejects(
      factory.write.createMarket([
        "Invalid Timing",
        BigInt(now + 200),
        BigInt(now + 100), // effectiveTo BEFORE effectiveFrom
        BigInt(now + 300),
        BigInt(now + 500),
        totalSeed,
        5000n,
        ZERO_ADDRESS,
        deployer.account.address,
      ]),
      (err: any) => err instanceof Error,
      "Invalid timing should revert"
    );
  });
});
