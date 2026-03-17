import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, keccak256, toBytes } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("Oracle Resolution", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, resolver] = await viem.getWalletClients();

  async function advanceTime(seconds: number | bigint) {
    const sec = typeof seconds === "bigint" ? Number(seconds) : seconds;
    await provider.send("evm_increaseTime", [sec]);
    await provider.send("evm_mine");
  }

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async function deployContracts() {
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
    return { usdc, sayso, forwarder, oracle, factory };
  }

  async function createOracleMarket(
    factory: any,
    usdc: any,
    resolverAddress: `0x${string}`,
    timing?: { effectiveFrom: number; effectiveTo: number; resolutionOpen: number; resolutionClose: number },
  ) {
    const now = await getNow();
    const t = timing || {
      effectiveFrom: now,
      effectiveTo: now + 200,
      resolutionOpen: now + 200,
      resolutionClose: now + 201,
    };
    const seedAmount = USDC(10);
    await usdc.write.mint([deployer.account.address, seedAmount]);
    await usdc.write.approve([factory.address, seedAmount]);

    await factory.write.createMarket([
      "Oracle Market",
      BigInt(t.effectiveFrom),
      BigInt(t.effectiveTo),
      BigInt(t.resolutionOpen),
      BigInt(t.resolutionClose),
      USDC(10),
      5000n,
      resolverAddress,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const marketAddress = markets[markets.length - 1];
    const market = await viem.getContractAt("AMM", marketAddress);
    return { market, marketAddress, ...t };
  }

  async function createVotingMarket(factory: any, usdc: any) {
    const now = await getNow();
    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    const seedAmount = USDC(10);
    await usdc.write.mint([deployer.account.address, seedAmount]);
    await usdc.write.approve([factory.address, seedAmount]);

    await factory.write.createMarket([
      "Voting Market",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(10),
      5000n,
      ZERO_ADDRESS as `0x${string}`,
      deployer.account.address,
    ]);

    const markets = await factory.read.getAllMarkets();
    const marketAddress = markets[markets.length - 1];
    const market = await viem.getContractAt("AMM", marketAddress);
    return { market, marketAddress, effectiveFrom, effectiveTo, resolutionOpen, resolutionClose };
  }

  // ─── Oracle Market Tests ───────────────────────────────

  it("oracle market: resolver is set correctly", async function () {
    const { usdc, factory } = await deployContracts();
    const { market } = await createOracleMarket(factory, usdc, resolver.account.address);
    const resolverAddr = await market.read.resolver();
    assert.equal(resolverAddr.toLowerCase(), resolver.account.address.toLowerCase());
  });

  it("oracle market: resolveAsOracle works after trading ends", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, effectiveTo } = await createOracleMarket(factory, usdc, resolver.account.address);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    const proofHash = keccak256(toBytes(JSON.stringify({ price: 100, target: 95 })));
    await market.write.resolveAsOracle([true, proofHash], { account: resolver.account });

    const resolved = await market.read.resolved();
    const outcome = await market.read.outcome();
    const storedHash = await market.read.proofHash();

    assert.equal(resolved, true);
    assert.equal(outcome, true);
    assert.equal(storedHash, proofHash);
  });

  it("oracle market: resolveAsOracle reverts before trading ends", async function () {
    const { usdc, factory } = await deployContracts();
    const { market } = await createOracleMarket(factory, usdc, resolver.account.address);

    const proofHash = keccak256(toBytes("proof"));
    let reverted = false;
    try {
      await market.write.resolveAsOracle([true, proofHash], { account: resolver.account });
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "Should revert before effectiveTo");
  });

  it("oracle market: non-resolver cannot call resolveAsOracle", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, effectiveTo } = await createOracleMarket(factory, usdc, resolver.account.address);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    const proofHash = keccak256(toBytes("proof"));
    let reverted = false;
    try {
      await market.write.resolveAsOracle([true, proofHash], { account: alice.account });
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "Non-resolver should not be able to resolve");
  });

  it("oracle market: resolve() reverts on oracle market", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, resolutionClose } = await createOracleMarket(factory, usdc, resolver.account.address);

    const now = await getNow();
    await advanceTime(resolutionClose - now + 1);

    let reverted = false;
    try {
      await market.write.resolve();
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "resolve() should revert on oracle market");
  });

  it("oracle market: cannot resolve twice", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, effectiveTo } = await createOracleMarket(factory, usdc, resolver.account.address);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    const proofHash = keccak256(toBytes("proof"));
    await market.write.resolveAsOracle([true, proofHash], { account: resolver.account });

    let reverted = false;
    try {
      await market.write.resolveAsOracle([false, proofHash], { account: resolver.account });
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "Should not resolve twice");
  });

  it("oracle market: full lifecycle — bet, resolve, claim", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, effectiveTo } = await createOracleMarket(factory, usdc, resolver.account.address);

    // Fund users
    await usdc.write.mint([alice.account.address, USDC(1000)]);
    await usdc.write.mint([bob.account.address, USDC(1000)]);

    // Alice bets YES
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    // Bob bets NO
    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    // Advance past trading
    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve as YES
    const proofHash = keccak256(toBytes(JSON.stringify({ price: 100, target: 95 })));
    await market.write.resolveAsOracle([true, proofHash], { account: resolver.account });

    // Alice (winner) can claim immediately
    const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    const aliceAfter = await usdc.read.balanceOf([alice.account.address]);
    assert.ok(aliceAfter > aliceBefore, "Alice should receive USDC from claim");

    // Bob (loser) cannot claim
    let reverted = false;
    try {
      await market.write.claim({ account: bob.account });
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "Bob should not be able to claim (loser)");
  });

  it("oracle market: resolve with NO outcome", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, effectiveTo } = await createOracleMarket(factory, usdc, resolver.account.address);

    // Fund and bet
    await usdc.write.mint([alice.account.address, USDC(1000)]);
    await usdc.write.mint([bob.account.address, USDC(1000)]);

    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Resolve as NO
    const proofHash = keccak256(toBytes(JSON.stringify({ price: 90, target: 95 })));
    await market.write.resolveAsOracle([false, proofHash], { account: resolver.account });

    const outcome = await market.read.outcome();
    assert.equal(outcome, false, "Outcome should be NO");

    // Bob (NO bettor) can claim
    const bobBefore = await usdc.read.balanceOf([bob.account.address]);
    await market.write.claim({ account: bob.account });
    const bobAfter = await usdc.read.balanceOf([bob.account.address]);
    assert.ok(bobAfter > bobBefore, "Bob should receive USDC from claim");

    // Alice (YES bettor, loser) cannot claim
    let reverted = false;
    try {
      await market.write.claim({ account: alice.account });
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "Alice should not be able to claim (loser)");
  });

  it("oracle market: getOutcome returns false/false before resolution", async function () {
    const { usdc, factory } = await deployContracts();
    const { market } = await createOracleMarket(factory, usdc, resolver.account.address);

    const [yesWins, isResolved] = await market.read.getOutcome();
    assert.equal(isResolved, false);
    assert.equal(yesWins, false);
  });

  it("oracle market: getOutcome returns correct result after resolution", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, effectiveTo } = await createOracleMarket(factory, usdc, resolver.account.address);

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    const proofHash = keccak256(toBytes("proof"));
    await market.write.resolveAsOracle([true, proofHash], { account: resolver.account });

    const [yesWins, isResolved] = await market.read.getOutcome();
    assert.equal(isResolved, true);
    assert.equal(yesWins, true);
  });

  // ─── Voting Market Tests ──────────────────────────────

  it("voting market: resolver is address(0)", async function () {
    const { usdc, factory } = await deployContracts();
    const { market } = await createVotingMarket(factory, usdc);
    const resolverAddr = await market.read.resolver();
    assert.equal(resolverAddr, ZERO_ADDRESS);
  });

  it("voting market: resolveAsOracle reverts", async function () {
    const { usdc, factory } = await deployContracts();
    const { market, resolutionClose } = await createVotingMarket(factory, usdc);

    const now = await getNow();
    await advanceTime(resolutionClose - now + 1);

    const proofHash = keccak256(toBytes("proof"));
    let reverted = false;
    try {
      await market.write.resolveAsOracle([true, proofHash]);
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true, "resolveAsOracle should revert on voting market");
  });

  it("voting market: full lifecycle with voting resolution", async function () {
    const { usdc, sayso, factory, oracle } = await deployContracts();
    const { market, marketAddress, effectiveTo, resolutionOpen, resolutionClose } =
      await createVotingMarket(factory, usdc);

    // Fund users
    await usdc.write.mint([alice.account.address, USDC(1000)]);
    await usdc.write.mint([bob.account.address, USDC(1000)]);
    await sayso.write.mint([alice.account.address, SAYSO(100)]);

    // Place bets during trading period
    await advanceTime(2);
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
    await market.write.buyNo([USDC(100)], { account: bob.account });

    // Advance to resolution window
    const now2 = await getNow();
    await advanceTime(resolutionOpen - now2 + 1);

    // Alice votes YES
    await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
    await oracle.write.voteYes([marketAddress, SAYSO(100)], { account: alice.account });

    // Advance past resolution close
    const now3 = await getNow();
    await advanceTime(resolutionClose - now3 + 1);

    // Resolve via voting
    await market.write.resolve();

    const [yesWins, isResolved] = await market.read.getOutcome();
    assert.equal(isResolved, true);
    assert.equal(yesWins, true);

    // Alice can claim
    const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    const aliceAfter = await usdc.read.balanceOf([alice.account.address]);
    assert.ok(aliceAfter > aliceBefore, "Alice should receive USDC");
  });

  it("voting market: resolve() works normally", async function () {
    const { usdc, sayso, factory, oracle } = await deployContracts();
    const { market, marketAddress, resolutionOpen, resolutionClose } =
      await createVotingMarket(factory, usdc);

    await sayso.write.mint([deployer.account.address, SAYSO(100)]);

    // Vote during resolution window
    const now = await getNow();
    await advanceTime(resolutionOpen - now + 1);

    await sayso.write.approve([oracle.address, SAYSO(50)]);
    await oracle.write.voteNo([marketAddress, SAYSO(50)]);

    // Advance past resolution close
    const now2 = await getNow();
    await advanceTime(resolutionClose - now2 + 1);

    await market.write.resolve();

    const resolved = await market.read.resolved();
    const outcome = await market.read.outcome();
    assert.equal(resolved, true);
    assert.equal(outcome, false, "NO should win since only NO votes");
  });
});
