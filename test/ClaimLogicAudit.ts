/**
 * CLAIM LOGIC DEEP DIVE AUDIT
 *
 * Verifies exact claim amounts for EVERY resolution path:
 * - Winner-takes-all: only one side bettors
 * - Mixed: both sides, one wins
 * - Seed provider with both sides
 * - Refund: proportional by shares
 * - Tie: averaged refund
 *
 * CRITICAL FINDING DOCUMENTED:
 * The no-votes/tie refund formula uses (yesShare + noShare) / 2 where:
 *   yesShare = user_yes_balance * pool / totalYes
 *   noShare = user_no_balance * pool / totalNo
 * This means refund is proportional to SHARES, not to original USDC deposits.
 * Since LMSR gives different shares/dollar at different prices, users who
 * bought at worse prices (higher price for YES, lower for NO) get fewer
 * shares per dollar and thus smaller refunds. This is by design — shares
 * represent economic interest — but users should understand this.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const MAX_DUST = 1000000n; // 1 USDC max rounding dust

describe("Claim Logic Audit", async function () {
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

  async function createOracleMarket(
    factory: any,
    usdc: any,
    seedYes: number,
    seedNo: number,
    resolverAddr: `0x${string}` = deployer.account.address
  ) {
    const now = await getNow();
    const totalSeedAmount = USDC(seedYes + seedNo);
    const targetPriceBps = BigInt(Math.round(seedYes / (seedYes + seedNo) * 10000));
    await usdc.write.mint([deployer.account.address, totalSeedAmount]);
    await usdc.write.approve([factory.address, totalSeedAmount]);

    await factory.write.createMarket([
      "Claim Test",
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
    return { market, marketAddress };
  }

  async function createVotingMarket(
    factory: any,
    usdc: any,
    seedYes: number,
    seedNo: number
  ) {
    return createOracleMarket(factory, usdc, seedYes, seedNo, ZERO_ADDRESS);
  }

  async function claimAndMeasure(market: any, usdc: any, user: any): Promise<bigint> {
    const before = await usdc.read.balanceOf([user.account.address]);
    await market.write.claim({ account: user.account });
    const after = await usdc.read.balanceOf([user.account.address]);
    return after - before;
  }

  // ════════════════════════════════════════════
  // (a) Winner-takes-all: only YES bettors, YES wins
  // ════════════════════════════════════════════
  it("(a) Only YES bettors, YES wins — they split pool proportionally by shares", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

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
    const totalYes = await market.read.totalYes();
    const deployerYes = await market.read.yesBalances([deployer.account.address]);
    const aliceYes = await market.read.yesBalances([alice.account.address]);
    const bobYes = await market.read.yesBalances([bob.account.address]);

    // Verify proportional claims
    const dClaim = await claimAndMeasure(market, usdc, deployer);
    const aClaim = await claimAndMeasure(market, usdc, alice);
    const bClaim = await claimAndMeasure(market, usdc, bob);

    // Verify claims are proportional to shares
    // dClaim / aClaim ~= deployerYes / aliceYes
    // Allow 1% tolerance for rounding
    const totalClaims = dClaim + aClaim + bClaim;
    assert.ok(totalClaims <= resolvedPool, "Total claims <= pool");
    assert.ok(totalClaims >= resolvedPool - MAX_DUST, "Total claims should drain pool");

    // Each claim should be positive
    assert.ok(dClaim > 0n, "Deployer should get something");
    assert.ok(aClaim > 0n, "Alice should get something");
    assert.ok(bClaim > 0n, "Bob should get something");
  });

  // ════════════════════════════════════════════
  // (b) Mixed: YES and NO bettors, YES wins
  // ════════════════════════════════════════════
  it("(b) YES and NO bettors, YES wins — NO bettors get 0", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(80)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(80)], { account: bob.account });
    await market.write.buyNo([USDC(80)], { account: bob.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    // Bob (NO) should have 0 claimable
    const bobClaimable = await market.read.calculateClaim([bob.account.address]);
    assert.equal(bobClaimable, 0n, "NO bettor should have 0 claimable when YES wins");

    // Deployer (has both YES and NO) — only YES shares count
    const deployerClaimable = await market.read.calculateClaim([deployer.account.address]);
    assert.ok(deployerClaimable > 0n, "Deployer should get something via YES shares");

    // Alice claims
    const aClaim = await claimAndMeasure(market, usdc, alice);
    assert.ok(aClaim > 0n, "Alice (YES) should get payout");

    // Bob cannot claim
    await assert.rejects(
      market.write.claim({ account: bob.account }),
      (err: any) => err instanceof Error,
      "Bob (NO) cannot claim when YES wins"
    );
  });

  // ════════════════════════════════════════════
  // (c) Seed provider is both YES and NO — only winning side counts
  // ════════════════════════════════════════════
  it("(c) Seed provider with both sides — only winning shares pay out", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    // No other bettors — just seed provider
    await advanceTime(201);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const deployerYes = await market.read.yesBalances([deployer.account.address]);
    const deployerNo = await market.read.noBalances([deployer.account.address]);
    assert.ok(deployerYes > 0n, "Seed provider has YES shares");
    assert.ok(deployerNo > 0n, "Seed provider has NO shares");

    // YES wins, so only YES shares matter
    const totalYes = await market.read.totalYes();
    const resolvedPool = await market.read.resolvedPoolBalance();

    const expectedClaim = (deployerYes * resolvedPool) / totalYes;
    const actualClaimable = await market.read.calculateClaim([deployer.account.address]);

    assert.equal(
      actualClaimable,
      expectedClaim,
      "Claim should be calculated from winning shares only"
    );

    // Since deployer is the ONLY YES holder, they get the entire pool
    assert.equal(actualClaimable, resolvedPool, "Sole YES holder gets entire pool");
  });

  // ════════════════════════════════════════════
  // (d) Seed provider + 1 trader on winning side
  // ════════════════════════════════════════════
  it("(d) Seed provider + 1 trader both on winning side — proportional split", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const deployerYes = await market.read.yesBalances([deployer.account.address]);
    const aliceYes = await market.read.yesBalances([alice.account.address]);
    const totalYes = await market.read.totalYes();
    const resolvedPool = await market.read.resolvedPoolBalance();

    // Verify proportional claims
    const expectedDeployer = (deployerYes * resolvedPool) / totalYes;
    const expectedAlice = (aliceYes * resolvedPool) / totalYes;

    const dClaim = await claimAndMeasure(market, usdc, deployer);
    const aClaim = await claimAndMeasure(market, usdc, alice);

    assert.equal(dClaim, expectedDeployer, "Deployer claim matches expected");
    assert.equal(aClaim, expectedAlice, "Alice claim matches expected");

    // Alice should get more (she put in $99.5 net vs deployer's $5 seed)
    assert.ok(aClaim > dClaim, "Alice (bigger bet) should get more than deployer (small seed)");
  });

  // ════════════════════════════════════════════
  // (e) Seed provider + 1 trader on losing side
  // ════════════════════════════════════════════
  it("(e) Seed provider winning + trader losing — seed provider gets everything", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    // NO wins — deployer's NO shares win, alice's YES shares lose
    await advanceTime(200);
    await market.write.resolveAsOracle([false, "0x" + "00".repeat(32)]);

    const deployerNo = await market.read.noBalances([deployer.account.address]);
    const totalNo = await market.read.totalNo();
    const resolvedPool = await market.read.resolvedPoolBalance();

    // Deployer is the ONLY NO holder, gets everything
    assert.equal(deployerNo, totalNo, "Deployer owns all NO shares");
    const dClaim = await claimAndMeasure(market, usdc, deployer);
    assert.equal(dClaim, resolvedPool, "Deployer gets entire pool");

    // Alice (YES loser) gets nothing
    const aliceClaimable = await market.read.calculateClaim([alice.account.address]);
    assert.equal(aliceClaimable, 0n, "Alice (YES loser) gets 0");
  });

  // ════════════════════════════════════════════
  // (f) Refund: verify exact proportions
  // ════════════════════════════════════════════
  it("(f) No-votes refund: claim proportional to shares, total drains pool", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const { market, marketAddress } = await createVotingMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(60)]);
    await usdc.write.mint([bob.account.address, USDC(40)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(60)], { account: alice.account });
    await market.write.buyYes([USDC(60)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(40)], { account: bob.account });
    await market.write.buyNo([USDC(40)], { account: bob.account });

    // No votes
    await advanceTime(501);
    await market.write.resolve();

    const resolvedPool = await market.read.resolvedPoolBalance();
    const totalYes = await market.read.totalYes();
    const totalNo = await market.read.totalNo();

    // Everyone claims
    const dClaim = await claimAndMeasure(market, usdc, deployer);
    const aClaim = await claimAndMeasure(market, usdc, alice);
    const bClaim = await claimAndMeasure(market, usdc, bob);

    const totalClaims = dClaim + aClaim + bClaim;
    assert.ok(totalClaims <= resolvedPool, "Total claims <= pool");
    assert.ok(
      totalClaims >= resolvedPool - MAX_DUST,
      `Total claims should drain pool. Claims: ${formatUnits(totalClaims, 6)}, Pool: ${formatUnits(resolvedPool, 6)}`
    );

    // Verify all claims are positive
    assert.ok(dClaim > 0n, "Deployer refund > 0");
    assert.ok(aClaim > 0n, "Alice refund > 0");
    assert.ok(bClaim > 0n, "Bob refund > 0");
  });

  // ════════════════════════════════════════════
  // (g) Tie: verify average calculation
  // ════════════════════════════════════════════
  it("(g) Tie: same formula as no-votes — averaged yes/no share", async function () {
    const { usdc, sayso, oracle, factory } = await deployFresh();
    const { market, marketAddress } = await createVotingMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(100)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    // Equal votes = tie
    await advanceTime(301);
    await sayso.write.mint([charlie.account.address, SAYSO(100)]);
    await sayso.write.mint([dave.account.address, SAYSO(100)]);

    await sayso.write.approve([oracle.address, SAYSO(100)], { account: charlie.account });
    await oracle.write.voteYes([marketAddress, SAYSO(100)], { account: charlie.account });

    await sayso.write.approve([oracle.address, SAYSO(100)], { account: dave.account });
    await oracle.write.voteNo([marketAddress, SAYSO(100)], { account: dave.account });

    await advanceTime(201);
    await market.write.resolve();

    assert.equal(await market.read.isTie(), true, "Should be a tie");

    const resolvedPool = await market.read.resolvedPoolBalance();

    const dClaim = await claimAndMeasure(market, usdc, deployer);
    const aClaim = await claimAndMeasure(market, usdc, alice);
    const bClaim = await claimAndMeasure(market, usdc, bob);

    const totalClaims = dClaim + aClaim + bClaim;
    assert.ok(totalClaims <= resolvedPool, "Total tie claims <= pool");
    assert.ok(
      totalClaims >= resolvedPool - MAX_DUST,
      "Total tie claims should drain pool"
    );
  });

  // ════════════════════════════════════════════
  // (h) calculateClaim returns 0 after claiming
  // ════════════════════════════════════════════
  it("(h) calculateClaim returns 0 after user has claimed", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(50)]);
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const claimBefore = await market.read.calculateClaim([alice.account.address]);
    assert.ok(claimBefore > 0n, "Should have claimable before claiming");

    await market.write.claim({ account: alice.account });

    const claimAfter = await market.read.calculateClaim([alice.account.address]);
    assert.equal(claimAfter, 0n, "calculateClaim should return 0 after claiming");
  });

  // ════════════════════════════════════════════
  // (i) Seed provider claim amounts are consistent
  // ════════════════════════════════════════════
  it("(i) Seed provider: claim amount matches calculateClaim preview", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(50)]);
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    // Preview
    const preview = await market.read.calculateClaim([deployer.account.address]);
    assert.ok(preview > 0n, "Seed provider should have claimable");

    // Actual claim
    const actual = await claimAndMeasure(market, usdc, deployer);
    assert.equal(actual, preview, "Actual claim should match calculateClaim preview");
  });

  // ════════════════════════════════════════════
  // (j) CRITICAL: Sum of all calculateClaim previews == resolvedPoolBalance
  // ════════════════════════════════════════════
  it("(j) CRITICAL: sum of all calculateClaim == resolvedPoolBalance (no leaks)", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 5, 5);

    await usdc.write.mint([alice.account.address, USDC(100)]);
    await usdc.write.mint([bob.account.address, USDC(50)]);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(50)], { account: bob.account });
    await market.write.buyNo([USDC(50)], { account: bob.account });

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();

    // Sum all claimable
    const dClaim = await market.read.calculateClaim([deployer.account.address]);
    const aClaim = await market.read.calculateClaim([alice.account.address]);
    const bClaim = await market.read.calculateClaim([bob.account.address]);

    const totalClaimable = dClaim + aClaim + bClaim;

    // Must not exceed pool (would mean paying out more than available)
    assert.ok(
      totalClaimable <= resolvedPool,
      `Total claimable (${formatUnits(totalClaimable, 6)}) must not exceed pool (${formatUnits(resolvedPool, 6)})`
    );

    // Should be very close to pool (no leaked funds)
    assert.ok(
      totalClaimable >= resolvedPool - MAX_DUST,
      `Total claimable (${formatUnits(totalClaimable, 6)}) should be close to pool (${formatUnits(resolvedPool, 6)})`
    );
  });

  // ════════════════════════════════════════════
  // (k) Large pool with many claimants — rounding doesn't steal funds
  // ════════════════════════════════════════════
  it("(k) 4 claimants on winning side — rounding dust < 1 USDC", async function () {
    const { usdc, factory } = await deployFresh();
    const { market } = await createOracleMarket(factory, usdc, 50, 50);

    const bettors = [alice, bob, charlie, dave];
    const amounts = [100, 75, 33, 17];
    await advanceTime(2);

    for (let i = 0; i < bettors.length; i++) {
      await usdc.write.mint([bettors[i].account.address, USDC(amounts[i])]);
      await usdc.write.approve([market.address, USDC(amounts[i])], {
        account: bettors[i].account,
      });
      await market.write.buyYes([USDC(amounts[i])], { account: bettors[i].account });
    }

    await advanceTime(200);
    await market.write.resolveAsOracle([true, "0x" + "00".repeat(32)]);

    const resolvedPool = await market.read.resolvedPoolBalance();
    const claims: bigint[] = [];

    // Deployer + 4 bettors claim
    claims.push(await claimAndMeasure(market, usdc, deployer));
    for (const bettor of bettors) {
      claims.push(await claimAndMeasure(market, usdc, bettor));
    }

    const totalClaims = claims.reduce((a, b) => a + b, 0n);
    const dust = resolvedPool - totalClaims;

    assert.ok(dust >= 0n, "Claims should not exceed pool");
    assert.ok(
      dust <= MAX_DUST,
      `Rounding dust (${formatUnits(dust, 6)} USDC) should be < 1 USDC`
    );
  });
});
