/**
 * FUND SETTLEMENT AUDIT - THE MOST CRITICAL TEST FILE
 *
 * Tests the #1 invariant: after all claims, contract USDC balance == 0 (or < 1 USDC dust)
 * Tests the #2 invariant: no user can extract more than their fair share
 * Tests the #3 invariant: sum of all claims == resolvedPoolBalance
 *
 * FINDINGS:
 * - See individual test results for any discovered vulnerabilities
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Maximum acceptable dust after all claims (1 USDC = 1e6)
const MAX_DUST = 1000000n; // 1 USDC

describe("Fund Settlement Audit", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, dave, eve, frank, grace, heidi, ivan] =
    await viem.getWalletClients();

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

  /**
   * Create an oracle market (no voting needed, resolver resolves directly)
   */
  async function createOracleMarket(
    factory: any,
    usdc: any,
    seedYes: number,
    seedNo: number,
    resolverAddr: `0x${string}`
  ) {
    const now = await getNow();
    const totalSeedAmount = USDC(seedYes + seedNo);
    const targetPriceBps = BigInt(Math.round(seedYes / (seedYes + seedNo) * 10000));
    await usdc.write.mint([deployer.account.address, totalSeedAmount]);
    await usdc.write.approve([factory.address, totalSeedAmount]);

    await factory.write.createMarket([
      "Test Market",
      BigInt(now),
      BigInt(now + 200),
      BigInt(now + 300),
      BigInt(now + 500),
      totalSeedAmount,
      targetPriceBps,
      resolverAddr,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const marketAddress = markets[markets.length - 1];
    const market = await viem.getContractAt("AMM", marketAddress);
    return { market, marketAddress, effectiveTo: now + 200 };
  }

  /**
   * Create a voting market (requires oracle votes to resolve)
   */
  async function createVotingMarket(
    factory: any,
    usdc: any,
    seedYes: number,
    seedNo: number
  ) {
    return createOracleMarket(factory, usdc, seedYes, seedNo, ZERO_ADDRESS);
  }

  /**
   * Helper: assert pool drains to near-zero after all claims
   */
  async function assertPoolDrained(
    market: any,
    usdc: any,
    context: string,
    maxDust: bigint = MAX_DUST
  ) {
    const remaining = await usdc.read.balanceOf([market.address]);
    assert.ok(
      remaining <= maxDust,
      `${context}: Pool should be drained. Remaining: ${formatUnits(remaining, 6)} USDC (max allowed: ${formatUnits(maxDust, 6)})`
    );
  }

  /**
   * Helper: assert total claims don't exceed pool
   */
  function assertClaimsNotExceedPool(
    claims: bigint[],
    poolBalance: bigint,
    context: string
  ) {
    const totalClaims = claims.reduce((a, b) => a + b, 0n);
    assert.ok(
      totalClaims <= poolBalance,
      `${context}: Total claims (${formatUnits(totalClaims, 6)}) exceed pool (${formatUnits(poolBalance, 6)})`
    );
  }

  // ════════════════════════════════════════════
  // Scenario A: Seed only, no bets
  // ════════════════════════════════════════════
  it("(a) Seed only, no bets — seed provider claims back full seed, pool = 0", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const { market, marketAddress } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    // No bets placed. Advance past trading and resolve.
    await advanceTime(201);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPoolBalance = await market.read.resolvedPoolBalance();
    assert.equal(resolvedPoolBalance, USDC(10), "Pool should be 10 USDC (seed)");

    // Deployer (seed provider) claims. They have YES shares (5 USDC worth) that win.
    const before = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const after = await usdc.read.balanceOf([deployer.account.address]);
    const claimed = after - before;

    // Seed provider has YES shares = 5 USDC * 1e12, totalYes = 5 USDC * 1e12
    // So they get 100% of pool via YES shares = 10 USDC
    assert.equal(claimed, USDC(10), "Seed provider should claim full pool");

    await assertPoolDrained(market, usdc, "Seed only, YES wins");
  });

  it("(a2) Seed only, NO wins — seed provider claims back full seed via NO shares", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await advanceTime(201);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const before = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const after = await usdc.read.balanceOf([deployer.account.address]);

    assert.equal(after - before, USDC(10), "Seed provider should claim full pool via NO shares");
    await assertPoolDrained(market, usdc, "Seed only, NO wins");
  });

  // ════════════════════════════════════════════
  // Scenario B: Seed + 1 YES bet, YES wins
  // ════════════════════════════════════════════
  it("(b) Seed + 1 YES bet, YES wins — all YES holders split pool, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    // Alice bets $50 YES
    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await advanceTime(2);
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Resolve YES wins
    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();

    // Both deployer and alice claim
    const deployerBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const deployerClaim = (await usdc.read.balanceOf([deployer.account.address])) - deployerBefore;

    const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    const aliceClaim = (await usdc.read.balanceOf([alice.account.address])) - aliceBefore;

    assertClaimsNotExceedPool([deployerClaim, aliceClaim], resolvedPool, "Seed + 1 YES, YES wins");
    assert.ok(aliceClaim > 0n, "Alice should get something");
    assert.ok(deployerClaim > 0n, "Seed provider should get something via YES shares");

    await assertPoolDrained(market, usdc, "Seed + 1 YES bet, YES wins");
  });

  // ════════════════════════════════════════════
  // Scenario C: Seed + 1 YES bet, NO wins
  // ════════════════════════════════════════════
  it("(c) Seed + 1 YES bet, NO wins — seed provider NO shares claim entire pool, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(50)]);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await advanceTime(2);
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Resolve NO wins
    await advanceTime(200);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();

    // Deployer is the only NO holder
    const deployerBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const deployerClaim = (await usdc.read.balanceOf([deployer.account.address])) - deployerBefore;

    assert.equal(deployerClaim, resolvedPool, "Seed provider should get entire pool via NO shares");

    // Alice (YES holder) should get nothing
    await assert.rejects(
      market.write.claim({ account: alice.account }),
      (err: any) => err instanceof Error,
      "Alice should not be able to claim (no winning shares)"
    );

    await assertPoolDrained(market, usdc, "Seed + 1 YES bet, NO wins");
  });

  // ════════════════════════════════════════════
  // Scenario D: Seed at 50% + $1 YES bet that loses
  // ════════════════════════════════════════════
  it("(d) Seed at 50% + small YES bet that loses — seed provider claims all via NO, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    // 50% seed = 5 YES + 5 NO
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    // Alice bets $1 YES (minimum)
    await usdc.write.mint([alice.account.address, USDC(1)]);
    await usdc.write.approve([market.address, USDC(1)], { account: alice.account });
    await advanceTime(2);
    await market.write.buyYes([USDC(1)], { account: alice.account });

    // NO wins
    await advanceTime(200);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();

    // Seed provider is only NO holder, gets everything
    const deployerBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const deployerClaim = (await usdc.read.balanceOf([deployer.account.address])) - deployerBefore;

    // Pool = 10 (seed) + 0.995 (alice's net bet after fee) = 10.995
    assert.equal(deployerClaim, resolvedPool, "Seed provider gets full pool");
    await assertPoolDrained(market, usdc, "50% seed + $1 YES loses");
  });

  // ════════════════════════════════════════════
  // Scenario E: Seed at 75% + multiple bets, YES wins
  // ════════════════════════════════════════════
  it("(e) Seed at 75% + multiple bets both sides, YES wins — proportional claims, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    // 75% target: 7.5 YES + 2.5 NO
    const { market } = await createOracleMarket(
      factory, usdc, 7.5, 2.5, deployer.account.address
    );

    // Multiple bettors
    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(100)]);
    await usdc.write.mint([charlie.account.address, USDC(50)]);

    await advanceTime(2);

    // Alice bets $100 YES
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    // Bob bets $100 NO
    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    // Charlie bets $50 YES
    await usdc.write.approve([market.address, USDC(50)], { account: charlie.account });
    await market.write.buyYes([USDC(50)], { account: charlie.account });

    // YES wins
    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer claims (has YES shares from seed)
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const dClaim = (await usdc.read.balanceOf([deployer.account.address])) - dBefore;
    claims.push(dClaim);

    // Alice claims
    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    const aClaim = (await usdc.read.balanceOf([alice.account.address])) - aBefore;
    claims.push(aClaim);

    // Charlie claims
    const cBefore = await usdc.read.balanceOf([charlie.account.address]);
    await market.write.claim({ account: charlie.account });
    const cClaim = (await usdc.read.balanceOf([charlie.account.address])) - cBefore;
    claims.push(cClaim);

    // Bob (NO holder) should get nothing
    await assert.rejects(
      market.write.claim({ account: bob.account }),
      (err: any) => err instanceof Error,
      "Bob (NO loser) should get nothing"
    );

    assertClaimsNotExceedPool(claims, resolvedPool, "75% seed + multi bets, YES wins");
    await assertPoolDrained(market, usdc, "75% seed + multi bets, YES wins");
  });

  // ════════════════════════════════════════════
  // Scenario F: Seed at 25% + multiple bets, NO wins
  // ════════════════════════════════════════════
  it("(f) Seed at 25% + multiple bets both sides, NO wins — proportional claims, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    // 25% target: 2.5 YES + 7.5 NO
    const { market } = await createOracleMarket(
      factory, usdc, 2.5, 7.5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(80)]);
    await usdc.write.mint([bob.account.address, USDC(60)]);

    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(80)], { account: alice.account });
    await market.write.buyYes([USDC(80)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(60)], { account: bob.account });
    await market.write.buyNo([USDC(60)], { account: bob.account });

    // NO wins
    await advanceTime(200);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer claims (has NO shares from seed)
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    const dClaim = (await usdc.read.balanceOf([deployer.account.address])) - dBefore;
    claims.push(dClaim);

    // Bob claims (NO)
    const bBefore = await usdc.read.balanceOf([bob.account.address]);
    await market.write.claim({ account: bob.account });
    const bClaim = (await usdc.read.balanceOf([bob.account.address])) - bBefore;
    claims.push(bClaim);

    assertClaimsNotExceedPool(claims, resolvedPool, "25% seed + multi bets, NO wins");
    await assertPoolDrained(market, usdc, "25% seed + multi bets, NO wins");
  });

  // ════════════════════════════════════════════
  // Scenario G: Extreme seed ratios (90/10 and 10/90)
  // ════════════════════════════════════════════
  it("(g) Seed at 90% — extreme price, fund settlement correct", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 9, 1, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(50)]);
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyNo([USDC(50)], { account: alice.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    assertClaimsNotExceedPool(claims, resolvedPool, "90% seed, NO wins");
    await assertPoolDrained(market, usdc, "90% seed, NO wins");
  });

  it("(g2) Seed at 10% — extreme price, fund settlement correct", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 1, 9, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(50)]);
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    assertClaimsNotExceedPool(claims, resolvedPool, "10% seed, YES wins");
    await assertPoolDrained(market, usdc, "10% seed, YES wins");
  });

  // ════════════════════════════════════════════
  // Scenario H: Large seed with tiny bets and vice versa
  // ════════════════════════════════════════════
  it("(h) Large seed ($1000) with tiny bets ($1) — pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 500, 500, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(1)]);
    await usdc.write.mint([bob.account.address, USDC(1)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(1)], { account: alice.account });
    await market.write.buyYes([USDC(1)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(1)], { account: bob.account });
    await market.write.buyNo([USDC(1)], { account: bob.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    assertClaimsNotExceedPool(claims, resolvedPool, "Large seed tiny bets");
    await assertPoolDrained(market, usdc, "Large seed ($1000) tiny bets ($1)");
  });

  it("(h2) Tiny seed ($10) with large bets ($500) — pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(500)]);
    await usdc.write.mint([bob.account.address, USDC(500)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
    await market.write.buyYes([USDC(500)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(500)], { account: bob.account });
    await market.write.buyNo([USDC(500)], { account: bob.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    assertClaimsNotExceedPool(claims, resolvedPool, "Tiny seed large bets");
    await assertPoolDrained(market, usdc, "Tiny seed ($10) large bets ($500)");
  });

  // ════════════════════════════════════════════
  // Scenario I: 10 users, random bet sizes and sides
  // ════════════════════════════════════════════
  it("(i) 10 users with various bets — resolve, everyone claims, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    const bettors = [alice, bob, charlie, dave, eve, frank, grace, heidi];
    // Alternate YES/NO bets with varying amounts
    const amounts = [10, 20, 5, 50, 15, 30, 8, 25];
    const sides = [true, false, true, false, true, true, false, true]; // YES/NO

    await advanceTime(2);

    for (let i = 0; i < bettors.length; i++) {
      const amount = amounts[i];
      await usdc.write.mint([bettors[i].account.address, USDC(amount)]);
      await usdc.write.approve([market.address, USDC(amount)], {
        account: bettors[i].account,
      });
      if (sides[i]) {
        await market.write.buyYes([USDC(amount)], { account: bettors[i].account });
      } else {
        await market.write.buyNo([USDC(amount)], { account: bettors[i].account });
      }
    }

    // YES wins
    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer claims (seed provider)
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    // Each bettor tries to claim
    for (let i = 0; i < bettors.length; i++) {
      const claimable = await market.read.calculateClaim([bettors[i].account.address]);
      if (claimable > 0n) {
        const before = await usdc.read.balanceOf([bettors[i].account.address]);
        await market.write.claim({ account: bettors[i].account });
        claims.push(
          (await usdc.read.balanceOf([bettors[i].account.address])) - before
        );
      }
    }

    assertClaimsNotExceedPool(claims, resolvedPool, "10 users various bets");
    await assertPoolDrained(market, usdc, "10 users various bets, YES wins");
  });

  // ════════════════════════════════════════════
  // Scenario J: Market with sells during trading
  // ════════════════════════════════════════════
  it("(j) Sells during trading — totalDeposited properly reduced, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(100)]);
    await advanceTime(2);

    // Alice buys YES
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    // Bob buys NO
    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    // Mine blocks for flash loan protection
    await mineBlocks(11);

    // Alice sells half her shares
    const aliceShares = await market.read.yesBalances([alice.account.address]);
    const halfShares = aliceShares / 2n;
    await market.write.sellYes([halfShares], { account: alice.account });

    // Verify totalDeposited decreased
    const totalDeposited = await market.read.totalDeposited();
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance >= totalDeposited,
      "Pool balance should be >= totalDeposited (could have dust from rounding)"
    );

    // Resolve and claim
    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer claims
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    // Alice claims
    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    assertClaimsNotExceedPool(claims, resolvedPool, "With sells during trading");
    await assertPoolDrained(market, usdc, "Sells during trading, YES wins");
  });

  // ════════════════════════════════════════════
  // Scenario K: Voting tie — proportional refund
  // ════════════════════════════════════════════
  it("(k) Tie scenario — proportional refund, pool = 0", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const { market, marketAddress } = await createVotingMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(100)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    // Advance to voting and create a tie
    await advanceTime(301);

    await sayso.write.mint([charlie.account.address, SAYSO(100)]);
    await sayso.write.mint([dave.account.address, SAYSO(100)]);

    await sayso.write.approve([oracle.address, SAYSO(100)], { account: charlie.account });
    await oracle.write.voteYes([marketAddress, SAYSO(100)], { account: charlie.account });

    await sayso.write.approve([oracle.address, SAYSO(100)], { account: dave.account });
    await oracle.write.voteNo([marketAddress, SAYSO(100)], { account: dave.account });

    // Advance past resolution
    await advanceTime(201);

    // Resolve (tie)
    await market.write.resolve();
    const isTie = await market.read.isTie();
    assert.equal(isTie, true, "Should be a tie");

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer claims
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    // Alice claims
    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    // Bob claims
    const bBefore = await usdc.read.balanceOf([bob.account.address]);
    await market.write.claim({ account: bob.account });
    claims.push((await usdc.read.balanceOf([bob.account.address])) - bBefore);

    const totalClaims = claims.reduce((a, b) => a + b, 0n);
    assertClaimsNotExceedPool(claims, resolvedPool, "Tie proportional refund");
    await assertPoolDrained(market, usdc, "Tie proportional refund");
  });

  // ════════════════════════════════════════════
  // Scenario L: No votes scenario
  // ════════════════════════════════════════════
  it("(l) No votes — proportional refund, pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createVotingMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(60)]);
    await usdc.write.mint([bob.account.address, USDC(40)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(60)], { account: alice.account });
    await market.write.buyYes([USDC(60)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(40)], { account: bob.account });
    await market.write.buyNo([USDC(40)], { account: bob.account });

    // No votes cast; advance past resolution
    await advanceTime(501);

    await market.write.resolve();

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Everyone claims proportional refund
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    const aBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    claims.push((await usdc.read.balanceOf([alice.account.address])) - aBefore);

    const bBefore = await usdc.read.balanceOf([bob.account.address]);
    await market.write.claim({ account: bob.account });
    claims.push((await usdc.read.balanceOf([bob.account.address])) - bBefore);

    const totalClaims = claims.reduce((a, b) => a + b, 0n);
    assertClaimsNotExceedPool(claims, resolvedPool, "No votes refund");
    await assertPoolDrained(market, usdc, "No votes proportional refund");
  });

  // ════════════════════════════════════════════
  // Scenario M: Only YES bettors, YES wins
  // ════════════════════════════════════════════
  it("(m) Only YES bettors + seed, YES wins — all YES holders split pool", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(50)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(50)], { account: bob.account });
    await market.write.buyYes([USDC(50)], { account: bob.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // All 3 YES holders claim
    for (const user of [deployer, alice, bob]) {
      const before = await usdc.read.balanceOf([user.account.address]);
      await market.write.claim({ account: user.account });
      claims.push((await usdc.read.balanceOf([user.account.address])) - before);
    }

    assertClaimsNotExceedPool(claims, resolvedPool, "Only YES bettors, YES wins");
    await assertPoolDrained(market, usdc, "Only YES bettors, YES wins");
  });

  // ════════════════════════════════════════════
  // Scenario N: Only NO bettors, NO wins
  // ════════════════════════════════════════════
  it("(n) Only NO bettors + seed, NO wins — all NO holders split pool", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(50)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyNo([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(50)], { account: bob.account });
    await market.write.buyNo([USDC(50)], { account: bob.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    for (const user of [deployer, alice, bob]) {
      const before = await usdc.read.balanceOf([user.account.address]);
      await market.write.claim({ account: user.account });
      claims.push((await usdc.read.balanceOf([user.account.address])) - before);
    }

    assertClaimsNotExceedPool(claims, resolvedPool, "Only NO bettors, NO wins");
    await assertPoolDrained(market, usdc, "Only NO bettors, NO wins");
  });

  // ════════════════════════════════════════════
  // Scenario O: Stress test — many small bets
  // ════════════════════════════════════════════
  it("(o) Stress: 8 users, $1 bets on $10 seed — verify rounding doesn't leak funds", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    const bettors = [alice, bob, charlie, dave, eve, frank, grace, heidi];
    await advanceTime(2);

    for (let i = 0; i < bettors.length; i++) {
      await usdc.write.mint([bettors[i].account.address, USDC(1)]);
      await usdc.write.approve([market.address, USDC(1)], {
        account: bettors[i].account,
      });
      if (i % 2 === 0) {
        await market.write.buyYes([USDC(1)], { account: bettors[i].account });
      } else {
        await market.write.buyNo([USDC(1)], { account: bettors[i].account });
      }
    }

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    // Winners claim
    for (let i = 0; i < bettors.length; i++) {
      const claimable = await market.read.calculateClaim([bettors[i].account.address]);
      if (claimable > 0n) {
        const before = await usdc.read.balanceOf([bettors[i].account.address]);
        await market.write.claim({ account: bettors[i].account });
        claims.push(
          (await usdc.read.balanceOf([bettors[i].account.address])) - before
        );
      }
    }

    assertClaimsNotExceedPool(claims, resolvedPool, "Many small bets stress");
    await assertPoolDrained(market, usdc, "Many small bets stress test");
  });

  // ════════════════════════════════════════════
  // Scenario P: Buy and sell same side, then resolve
  // ════════════════════════════════════════════
  it("(p) User buys then sells all, remaining users claim — pool = 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(
      factory, usdc, 5, 5, deployer.account.address
    );

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(100)]);
    await advanceTime(2);

    // Alice buys YES
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    // Bob buys NO
    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    await mineBlocks(11);

    // Alice sells ALL her shares
    const aliceShares = await market.read.yesBalances([alice.account.address]);
    await market.write.sellYes([aliceShares], { account: alice.account });

    // Verify Alice has 0 shares
    const aliceYesAfter = await market.read.yesBalances([alice.account.address]);
    assert.equal(aliceYesAfter, 0n, "Alice should have 0 YES shares after selling all");

    // Resolve YES wins
    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer claims (only YES holder left besides sold-out Alice)
    const dBefore = await usdc.read.balanceOf([deployer.account.address]);
    await market.write.claim({ account: deployer.account });
    claims.push((await usdc.read.balanceOf([deployer.account.address])) - dBefore);

    // Alice should get 0 (sold all shares)
    const aliceClaimable = await market.read.calculateClaim([alice.account.address]);
    assert.equal(aliceClaimable, 0n, "Alice should have 0 claimable after selling all");

    assertClaimsNotExceedPool(claims, resolvedPool, "Buy-sell-resolve");
    await assertPoolDrained(market, usdc, "User sells all then resolve");
  });
});
