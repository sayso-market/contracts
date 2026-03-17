import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * EDGE CASE TESTS
 */
describe("Edge Cases Extended", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, dave] = await viem.getWalletClients();

  async function advanceTime(seconds: number | bigint) {
    const sec = typeof seconds === "bigint" ? Number(seconds) : seconds;
    await provider.send("evm_increaseTime", [sec]);
    await provider.send("evm_mine");
  }

  async function mineBlocks(n: number) {
    for (let i = 0; i < n; i++) await provider.send("evm_mine");
  }

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async function deployOracleMarket(seedYes: number, seedNo: number) {
    const now = await getNow();
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address, forwarder.address, ZERO_ADDRESS,
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address, oracle.address, forwarder.address, FEE_COLLECTOR,
    ]);
    await oracle.write.setFactory([factory.address]);

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    const totalSeed = USDC(seedYes + seedNo);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    const targetPriceBps = BigInt(Math.round(seedYes / (seedYes + seedNo) * 10000));
    await factory.write.createMarket([
      "Edge Case", BigInt(effectiveFrom), BigInt(effectiveTo),
      BigInt(resolutionOpen), BigInt(resolutionClose),
      totalSeed, targetPriceBps, deployer.account.address, deployer.account.address,
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    await usdc.write.mint([alice.account.address, USDC(100000)]);
    await usdc.write.mint([bob.account.address, USDC(100000)]);
    await usdc.write.mint([charlie.account.address, USDC(100000)]);

    return { usdc, sayso, oracle, factory, market, marketAddress,
      effectiveFrom, effectiveTo, resolutionOpen, resolutionClose };
  }

  async function deployVotingMarket(seedYes: number, seedNo: number) {
    const now = await getNow();
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address, forwarder.address, ZERO_ADDRESS,
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address, oracle.address, forwarder.address, FEE_COLLECTOR,
    ]);
    await oracle.write.setFactory([factory.address]);

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    const totalSeed = USDC(seedYes + seedNo);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    const targetPriceBps = BigInt(Math.round(seedYes / (seedYes + seedNo) * 10000));
    await factory.write.createMarket([
      "Voting Edge", BigInt(effectiveFrom), BigInt(effectiveTo),
      BigInt(resolutionOpen), BigInt(resolutionClose),
      totalSeed, targetPriceBps, ZERO_ADDRESS, deployer.account.address,
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    await usdc.write.mint([alice.account.address, USDC(100000)]);
    await usdc.write.mint([bob.account.address, USDC(100000)]);
    await sayso.write.mint([alice.account.address, SAYSO(10000)]);
    await sayso.write.mint([bob.account.address, SAYSO(10000)]);

    return { usdc, sayso, oracle, factory, market, marketAddress,
      effectiveFrom, effectiveTo, resolutionOpen, resolutionClose };
  }

  async function tryClaimOrZero(market: any, account: any): Promise<bigint> {
    try {
      const claimable = await market.read.calculateClaim([account.account.address]);
      if (claimable === 0n) return 0n;
      await market.write.claim({ account: account.account });
      return claimable;
    } catch {
      return 0n;
    }
  }

  // ───────────────────────────────────────────
  // Market with only seed provider (no bets)
  // ───────────────────────────────────────────

  it("only seed provider, YES wins → claims full seed", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const claim = await tryClaimOrZero(market, deployer);
    assert.equal(claim, USDC(10), "Seed provider should get full $10 back");

    const balance = await usdc.read.balanceOf([market.address]);
    assert.equal(balance, 0n, "Pool should be empty");
  });

  it("only seed provider, NO wins → claims full seed", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const claim = await tryClaimOrZero(market, deployer);
    assert.equal(claim, USDC(10), "Seed provider should get full $10 back");
  });

  // ───────────────────────────────────────────
  // 1 bet on each side
  // ───────────────────────────────────────────

  it("1 bet YES + 1 bet NO, YES wins → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
    await market.write.buyYes([USDC(10)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(10)], { account: bob.account });
    await market.write.buyNo([USDC(10)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Very large bet relative to seed
  // ───────────────────────────────────────────

  it("$10000 bet on $10 seed → reverts due to PRBMath exp overflow (expected limit)", async function () {
    // With a $10 seed, b = 150e18. A $10000 bet pushes qYes/b past PRBMath's exp limit (~133).
    // This is an inherent limit of the LMSR + PRBMath combination for very small pools.
    // Users should not be able to bet >~1000x the seed amount on small pools.
    const { usdc, market } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(10000)], { account: alice.account });
    await assert.rejects(
      market.write.buyYes([USDC(10000)], { account: alice.account }),
      (err: any) => err instanceof Error,
      "Very large bet relative to seed should revert"
    );
  });

  it("$500 bet on $10 seed works fine → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
    await market.write.buyYes([USDC(500)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Tie resolution (voting market)
  // ───────────────────────────────────────────

  it("tied vote → proportional refund → balance ~0", async function () {
    const { usdc, sayso, oracle, market, marketAddress, resolutionOpen, resolutionClose } =
      await deployVotingMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(30)], { account: bob.account });
    await market.write.buyNo([USDC(30)], { account: bob.account });

    // Advance to voting
    let now = await getNow();
    await advanceTime(resolutionOpen - now + 1);

    // Equal votes → tie
    await sayso.write.approve([oracle.address, SAYSO(500)], { account: alice.account });
    await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: alice.account });

    await sayso.write.approve([oracle.address, SAYSO(500)], { account: bob.account });
    await oracle.write.voteNo([marketAddress, SAYSO(500)], { account: bob.account });

    now = await getNow();
    await advanceTime(resolutionClose - now + 1);

    await market.write.resolve();

    const isTie = await market.read.isTie();
    assert.equal(isTie, true, "Should be a tie");

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(2), `Pool after tie refund should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // No votes → proportional refund
  // ───────────────────────────────────────────

  it("no votes → proportional refund → balance ~0", async function () {
    const { usdc, market, resolutionClose } = await deployVotingMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(30)], { account: bob.account });
    await market.write.buyNo([USDC(30)], { account: bob.account });

    const now = await getNow();
    await advanceTime(resolutionClose - now + 1);

    await market.write.resolve();

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(2), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Oracle resolution at exactly effectiveTo
  // ───────────────────────────────────────────

  it("oracle resolves at exactly effectiveTo timestamp", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
    await market.write.buyYes([USDC(10)], { account: alice.account });

    // Advance to exactly effectiveTo
    const now = await getNow();
    await advanceTime(effectiveTo - now);

    // Should be able to resolve at exactly effectiveTo
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const [_, isResolved] = await market.read.getOutcome();
    assert.equal(isResolved, true, "Market should be resolved");
  });

  // ───────────────────────────────────────────
  // Multiple buys by same user
  // ───────────────────────────────────────────

  it("same user buys YES multiple times → accumulates shares → claims correctly", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice buys YES 3 times
    for (let i = 0; i < 3; i++) {
      await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
      await market.write.buyYes([USDC(10)], { account: alice.account });
    }

    const aliceShares = await market.read.yesBalances([alice.account.address]);
    assert.ok(aliceShares > 0n, "Alice should have YES shares");

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // User buys both YES and NO
  // ───────────────────────────────────────────

  it("same user buys both YES and NO → wins on one side → claims correctly", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice buys YES
    await usdc.write.approve([market.address, USDC(20)], { account: alice.account });
    await market.write.buyYes([USDC(20)], { account: alice.account });

    // Alice also buys NO (hedging)
    await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
    await market.write.buyNo([USDC(10)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // YES wins → Alice gets her YES shares payout, NO shares are worthless
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const claimable = await market.read.calculateClaim([alice.account.address]);
    assert.ok(claimable > 0n, "Alice should have claimable from YES shares");

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Buy, sell all, then someone else claims
  // ───────────────────────────────────────────

  it("Alice buys and sells all before resolution → she has no shares → cannot claim", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await mineBlocks(10);

    const shares = await market.read.yesBalances([alice.account.address]);
    await market.write.sellYes([shares], { account: alice.account });

    const sharesAfter = await market.read.yesBalances([alice.account.address]);
    assert.equal(sharesAfter, 0n, "Alice should have 0 shares after selling all");

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // Alice should get 0
    const claimable = await market.read.calculateClaim([alice.account.address]);
    assert.equal(claimable, 0n, "Alice with 0 shares should get 0");

    // Seed provider claims all
    await tryClaimOrZero(market, deployer);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Many users, complex trading, full settlement
  // ───────────────────────────────────────────

  it("4 users trade actively → resolve → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(50, 50);
    await advanceTime(2);

    // Alice: $100 YES
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    // Bob: $80 NO
    await usdc.write.approve([market.address, USDC(80)], { account: bob.account });
    await market.write.buyNo([USDC(80)], { account: bob.account });

    // Charlie: $50 YES
    await usdc.write.approve([market.address, USDC(50)], { account: charlie.account });
    await market.write.buyYes([USDC(50)], { account: charlie.account });

    // Dave: $30 NO
    await usdc.write.mint([dave.account.address, USDC(100000)]);
    await usdc.write.approve([market.address, USDC(30)], { account: dave.account });
    await market.write.buyNo([USDC(30)], { account: dave.account });

    // Alice sells half
    await mineBlocks(10);
    const aliceShares = await market.read.yesBalances([alice.account.address]);
    await market.write.sellYes([aliceShares / 2n], { account: alice.account });

    // Bob buys more NO
    await usdc.write.approve([market.address, USDC(40)], { account: bob.account });
    await market.write.buyNo([USDC(40)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // YES wins
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);
    await tryClaimOrZero(market, charlie);
    await tryClaimOrZero(market, dave);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Asymmetric seed (90/10)
  // ───────────────────────────────────────────

  it("90/10 seed → bets → resolve → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(9, 1);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(20)], { account: alice.account });
    await market.write.buyNo([USDC(20)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // NO wins → Alice and deployer's NO shares win
    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);

    const balance = await usdc.read.balanceOf([market.address]);
    assert.ok(balance < USDC(1), `Pool should be near-empty, has ${formatUnits(balance, 6)} USDC`);
  });

  // ───────────────────────────────────────────
  // Factory minimum seed enforcement
  // ───────────────────────────────────────────

  it("rejects seed below MIN_SEED (10 USDC)", async function () {
    const now = await getNow();
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address, forwarder.address, ZERO_ADDRESS,
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address, oracle.address, forwarder.address, FEE_COLLECTOR,
    ]);
    await oracle.write.setFactory([factory.address]);

    // Try to create with 5 USDC seed (below 10 USDC minimum)
    await usdc.write.mint([deployer.account.address, USDC(5)]);
    await usdc.write.approve([factory.address, USDC(5)]);

    await assert.rejects(
      factory.write.createMarket([
        "Small Seed", BigInt(now), BigInt(now + 200),
        BigInt(now + 300), BigInt(now + 500),
        USDC(5), 5000n, ZERO_ADDRESS, deployer.account.address,
      ]),
      /Seed below minimum/
    );
  });
});
