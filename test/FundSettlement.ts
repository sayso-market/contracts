import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

/**
 * FUND SETTLEMENT TESTS
 *
 * After every market resolves and all users claim, the contract should have
 * approximately 0 USDC remaining (only dust from rounding).
 */
describe("Fund Settlement", async function () {
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

  /**
   * Deploy infrastructure and create an oracle-resolved market.
   * Oracle markets let us control the outcome directly (no voting needed).
   * @param seedYes - USDC seed for YES side
   * @param seedNo - USDC seed for NO side
   */
  async function deployOracleMarket(seedYes: number, seedNo: number) {
    const now = await getNow();
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

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    const totalSeed = USDC(seedYes + seedNo);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    // deployer is the resolver for oracle markets
    const targetPriceBps = BigInt(Math.round(seedYes / (seedYes + seedNo) * 10000));
    await factory.write.createMarket([
      "Test Market",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      totalSeed,
      targetPriceBps,
      deployer.account.address, // resolver = deployer
      deployer.account.address, // seedProvider
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Fund bettors
    await usdc.write.mint([alice.account.address, USDC(100000)]);
    await usdc.write.mint([bob.account.address, USDC(100000)]);
    await usdc.write.mint([charlie.account.address, USDC(100000)]);

    return {
      usdc,
      sayso,
      oracle,
      factory,
      market,
      marketAddress,
      effectiveFrom,
      effectiveTo,
      resolutionOpen,
      resolutionClose,
    };
  }

  /**
   * Deploy a voting-based market (no resolver).
   */
  async function deployVotingMarket(seedYes: number, seedNo: number) {
    const now = await getNow();
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

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    const totalSeed = USDC(seedYes + seedNo);
    await usdc.write.mint([deployer.account.address, totalSeed]);
    await usdc.write.approve([factory.address, totalSeed]);

    const targetPriceBps = BigInt(Math.round(seedYes / (seedYes + seedNo) * 10000));
    await factory.write.createMarket([
      "Voting Market",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      totalSeed,
      targetPriceBps,
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      deployer.account.address, // seedProvider
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    await usdc.write.mint([alice.account.address, USDC(100000)]);
    await usdc.write.mint([bob.account.address, USDC(100000)]);
    await usdc.write.mint([charlie.account.address, USDC(100000)]);

    // Fund voters with SAYSO
    await sayso.write.mint([alice.account.address, SAYSO(10000)]);
    await sayso.write.mint([bob.account.address, SAYSO(10000)]);

    return {
      usdc,
      sayso,
      oracle,
      factory,
      market,
      marketAddress,
      effectiveFrom,
      effectiveTo,
      resolutionOpen,
      resolutionClose,
    };
  }

  async function tryClaimOrZero(
    market: any,
    account: any
  ): Promise<bigint> {
    try {
      const claimable = await market.read.calculateClaim([
        account.account.address,
      ]);
      if (claimable === 0n) return 0n;
      await market.write.claim({ account: account.account });
      return claimable;
    } catch {
      return 0n;
    }
  }

  // ═══════════════════════════════════════════════════════
  // 1. Basic: seed provider + one bettor, all claim
  // ═══════════════════════════════════════════════════════

  it("$10 seed at 50%, $1 YES bet, YES loses → seed provider claims entire pool → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice bets $1 on YES
    await usdc.write.approve([market.address, USDC(1)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(1)], { account: alice.account });

    // Advance past trading
    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: NO wins (YES loses)
    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // Seed provider (deployer) has NO shares from seed → they are the winner
    const deployerClaimable = await market.read.calculateClaim([
      deployer.account.address,
    ]);
    // Alice has YES shares → she loses, should get 0
    const aliceClaimable = await market.read.calculateClaim([
      alice.account.address,
    ]);

    assert.equal(aliceClaimable, 0n, "Alice (YES loser) should get 0");
    assert.ok(deployerClaimable > 0n, "Deployer (NO winner) should get payout");

    // Both claim
    await market.write.claim({ account: deployer.account });
    // Alice can't claim (0 amount)

    const poolBalance = await usdc.read.balanceOf([market.address]);
    // Pool should be empty or near-empty (< 1 USDC dust)
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty after all claims, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  it("$10 seed at 50%, $1 YES bet, YES wins → Alice + seed provider claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice bets $1 on YES
    await usdc.write.approve([market.address, USDC(1)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(1)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: YES wins
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // Both have YES shares (deployer from seed, Alice from bet)
    const deployerClaim = await tryClaimOrZero(market, deployer);
    const aliceClaim = await tryClaimOrZero(market, alice);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 2. Various seed amounts and target prices
  // ═══════════════════════════════════════════════════════

  for (const seedTotal of [10, 100, 1000]) {
    for (const targetPriceBps of [2500, 5000, 7500, 9000]) {
      const yesAmount = (seedTotal * targetPriceBps) / 10000;
      const noAmount = seedTotal - yesAmount;

      it(`seed=$${seedTotal} target=${targetPriceBps / 100}% → Alice bets $10 YES, NO wins → all claim → balance ~0`, async function () {
        const { usdc, market, effectiveTo } = await deployOracleMarket(
          yesAmount,
          noAmount
        );
        await advanceTime(2);

        // Alice bets $10 on YES
        await usdc.write.approve([market.address, USDC(10)], {
          account: alice.account,
        });
        await market.write.buyYes([USDC(10)], { account: alice.account });

        const now = await getNow();
        await advanceTime(effectiveTo - now + 1);

        // Resolve: NO wins
        await market.write.resolveAsOracle(
          [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
          { account: deployer.account }
        );

        await tryClaimOrZero(market, deployer);
        await tryClaimOrZero(market, alice);

        const poolBalance = await usdc.read.balanceOf([market.address]);
        assert.ok(
          poolBalance < USDC(1),
          `seed=$${seedTotal} target=${targetPriceBps}bps: pool has ${formatUnits(poolBalance, 6)} USDC remaining`
        );
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // 3. Multiple users bet, all claim, sum = totalDeposited
  // ═══════════════════════════════════════════════════════

  it("3 users bet, YES wins → all claim → sum of claims = totalDeposited, balance = 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice bets $50 YES
    await usdc.write.approve([market.address, USDC(50)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Bob bets $30 NO
    await usdc.write.approve([market.address, USDC(30)], {
      account: bob.account,
    });
    await market.write.buyNo([USDC(30)], { account: bob.account });

    // Charlie bets $20 YES
    await usdc.write.approve([market.address, USDC(20)], {
      account: charlie.account,
    });
    await market.write.buyYes([USDC(20)], { account: charlie.account });

    const totalDeposited = await market.read.totalDeposited();

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: YES wins
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // All claim
    const deployerClaim = await tryClaimOrZero(market, deployer);
    const aliceClaim = await tryClaimOrZero(market, alice);
    const bobClaim = await tryClaimOrZero(market, bob); // loser, should be 0
    const charlieClaim = await tryClaimOrZero(market, charlie);

    const totalClaimed = deployerClaim + aliceClaim + bobClaim + charlieClaim;

    // Total claimed should approximately equal totalDeposited
    // Allow 1 USDC tolerance for rounding
    assert.ok(
      totalClaimed >= totalDeposited - USDC(1) &&
        totalClaimed <= totalDeposited,
      `Total claimed (${formatUnits(totalClaimed, 6)}) should ≈ totalDeposited (${formatUnits(totalDeposited, 6)})`
    );

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  it("3 users bet, NO wins → all claim → balance = 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice bets $50 YES
    await usdc.write.approve([market.address, USDC(50)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Bob bets $30 NO
    await usdc.write.approve([market.address, USDC(30)], {
      account: bob.account,
    });
    await market.write.buyNo([USDC(30)], { account: bob.account });

    // Charlie bets $20 NO
    await usdc.write.approve([market.address, USDC(20)], {
      account: charlie.account,
    });
    await market.write.buyNo([USDC(20)], { account: charlie.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: NO wins
    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);
    await tryClaimOrZero(market, charlie);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 4. Seed provider creates market AND bets wrong side
  // ═══════════════════════════════════════════════════════

  it("seed provider bets on losing side → still claims seed winning shares", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Deployer (seed provider) also bets $10 on YES
    await usdc.write.mint([deployer.account.address, USDC(10)]);
    await usdc.write.approve([market.address, USDC(10)], {
      account: deployer.account,
    });
    await market.write.buyYes([USDC(10)], { account: deployer.account });

    // Alice bets $5 on NO
    await usdc.write.approve([market.address, USDC(5)], {
      account: alice.account,
    });
    await market.write.buyNo([USDC(5)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: NO wins → deployer's YES bet loses, but seed NO shares win
    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // Deployer should still get a claim (from seed NO shares)
    const deployerClaimable = await market.read.calculateClaim([
      deployer.account.address,
    ]);
    assert.ok(
      deployerClaimable > 0n,
      "Deployer should claim from seed NO shares even though YES bet lost"
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 5. Only seed provider, no bets → claim back full seed
  // ═══════════════════════════════════════════════════════

  it("no bets → seed provider claims back full seed after resolution", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: YES wins
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const deployerBefore = await usdc.read.balanceOf([
      deployer.account.address,
    ]);
    await market.write.claim({ account: deployer.account });
    const deployerAfter = await usdc.read.balanceOf([
      deployer.account.address,
    ]);

    const claimed = deployerAfter - deployerBefore;
    // Seed provider had YES shares from seed. YES wins → gets proportional share.
    // But with only seed shares (50/50), the winning side (YES) gets all totalDeposited.
    // totalDeposited = 10 USDC. deployer has ALL YES shares. So claim = 10 USDC.
    // Wait — deployer has both YES and NO shares. Only YES wins.
    // deployer YES = 5 USDC worth of shares, totalYes = same. So claim = totalDeposited = 10 USDC.
    // But deployer's NO shares are lost. That's correct — seed provider takes the loss on the losing side.
    // Actually, deployer is the ONLY person. If YES wins, deployer is the only YES holder.
    // claim = (deployerYesShares / totalYes) * totalDeposited = 1 * 10 = 10
    assert.equal(
      claimed,
      USDC(10),
      `Seed provider should claim full $10 seed back (only participant)`
    );

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, 0n, "Pool should be completely empty");
  });

  it("no bets → NO wins → seed provider claims full seed", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve: NO wins
    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const deployerBefore = await usdc.read.balanceOf([
      deployer.account.address,
    ]);
    await market.write.claim({ account: deployer.account });
    const deployerAfter = await usdc.read.balanceOf([
      deployer.account.address,
    ]);

    const claimed = deployerAfter - deployerBefore;
    assert.equal(claimed, USDC(10), "Seed provider should claim full $10 seed back");

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, 0n, "Pool should be completely empty");
  });

  // ═══════════════════════════════════════════════════════
  // 6. Everyone bets same side
  // ═══════════════════════════════════════════════════════

  it("everyone bets YES, YES wins → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(30)], {
      account: bob.account,
    });
    await market.write.buyYes([USDC(30)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  it("everyone bets YES, NO wins → seed provider (only NO holder) claims all → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(30)], {
      account: bob.account,
    });
    await market.write.buyYes([USDC(30)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [false, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // Deployer is the only NO holder (from seed). Should get entire pool.
    const deployerClaim = await tryClaimOrZero(market, deployer);
    const aliceClaim = await tryClaimOrZero(market, alice);
    const bobClaim = await tryClaimOrZero(market, bob);

    assert.equal(aliceClaim, 0n, "Alice (YES loser) should get 0");
    assert.equal(bobClaim, 0n, "Bob (YES loser) should get 0");
    assert.ok(deployerClaim > 0n, "Deployer (only NO holder) should get entire pool");

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 7. Large bet relative to seed
  // ═══════════════════════════════════════════════════════

  it("$1000 bet on $10 seed → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(1000)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(1000)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 8. Minimum bet ($1 USDC)
  // ═══════════════════════════════════════════════════════

  it("minimum $1 bets → all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(1)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(1)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(1)], {
      account: bob.account,
    });
    await market.write.buyNo([USDC(1)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 9. Voting market with no votes → proportional refund → balance 0
  // ═══════════════════════════════════════════════════════

  it("voting market, no votes → refund → all claim → balance ~0", async function () {
    const { usdc, market, resolutionClose } = await deployVotingMarket(5, 5);
    await advanceTime(2);

    // Alice bets $50 YES, Bob bets $30 NO
    await usdc.write.approve([market.address, USDC(50)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(30)], {
      account: bob.account,
    });
    await market.write.buyNo([USDC(30)], { account: bob.account });

    // Skip to after resolution close — nobody votes
    const now = await getNow();
    await advanceTime(resolutionClose - now + 1);

    await market.write.resolve();

    // All claim (including seed provider)
    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    // In no-votes refund, claim = (yesShare + noShare) / 2
    // There might be leftover if the math doesn't perfectly drain
    assert.ok(
      poolBalance < USDC(2),
      `Pool should be near-empty after no-votes refund, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 10. Sell then resolve → balance 0
  // ═══════════════════════════════════════════════════════

  it("buy then sell partial, resolve, all claim → balance 0", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket(5, 5);
    await advanceTime(2);

    // Alice buys $50 YES
    await usdc.write.approve([market.address, USDC(50)], {
      account: alice.account,
    });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Mine blocks for flash loan protection
    await mineBlocks(10);

    // Alice sells half her shares
    const aliceShares = await market.read.yesBalances([
      alice.account.address,
    ]);
    await market.write.sellYes([aliceShares / 2n], {
      account: alice.account,
    });

    // Bob buys $20 NO
    await usdc.write.approve([market.address, USDC(20)], {
      account: bob.account,
    });
    await market.write.buyNo([USDC(20)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await tryClaimOrZero(market, deployer);
    await tryClaimOrZero(market, alice);
    await tryClaimOrZero(market, bob);

    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.ok(
      poolBalance < USDC(1),
      `Pool should be near-empty after sell + claim, but has ${formatUnits(poolBalance, 6)} USDC`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 11. Extreme target prices
  // ═══════════════════════════════════════════════════════

  for (const targetPriceBps of [1000, 9000]) {
    const yesAmount = (100 * targetPriceBps) / 10000;
    const noAmount = 100 - yesAmount;

    it(`seed=$100 target=${targetPriceBps / 100}% → bets + resolve → balance 0`, async function () {
      const { usdc, market, effectiveTo } = await deployOracleMarket(
        yesAmount,
        noAmount
      );
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(25)], {
        account: alice.account,
      });
      await market.write.buyYes([USDC(25)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(25)], {
        account: bob.account,
      });
      await market.write.buyNo([USDC(25)], { account: bob.account });

      const now = await getNow();
      await advanceTime(effectiveTo - now + 1);

      await market.write.resolveAsOracle(
        [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
        { account: deployer.account }
      );

      await tryClaimOrZero(market, deployer);
      await tryClaimOrZero(market, alice);
      await tryClaimOrZero(market, bob);

      const poolBalance = await usdc.read.balanceOf([market.address]);
      assert.ok(
        poolBalance < USDC(1),
        `Pool should be near-empty, but has ${formatUnits(poolBalance, 6)} USDC`
      );
    });
  }
});
