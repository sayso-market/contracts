import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * SECURITY TESTS — users can't steal funds
 */
describe("Claim Security", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, attacker] = await viem.getWalletClients();

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

  async function deployOracleMarket() {
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

    await usdc.write.mint([deployer.account.address, USDC(10)]);
    await usdc.write.approve([factory.address, USDC(10)]);

    await factory.write.createMarket([
      "Security Test", BigInt(effectiveFrom), BigInt(effectiveTo),
      BigInt(resolutionOpen), BigInt(resolutionClose),
      USDC(10), 5000n, deployer.account.address, deployer.account.address,
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    await usdc.write.mint([alice.account.address, USDC(10000)]);
    await usdc.write.mint([bob.account.address, USDC(10000)]);
    await usdc.write.mint([attacker.account.address, USDC(10000)]);

    return { usdc, sayso, oracle, factory, market, marketAddress,
      effectiveFrom, effectiveTo, resolutionOpen, resolutionClose };
  }

  async function deployVotingMarket() {
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

    await usdc.write.mint([deployer.account.address, USDC(10)]);
    await usdc.write.approve([factory.address, USDC(10)]);

    await factory.write.createMarket([
      "Voting Security", BigInt(effectiveFrom), BigInt(effectiveTo),
      BigInt(resolutionOpen), BigInt(resolutionClose),
      USDC(10), 5000n, ZERO_ADDRESS, deployer.account.address,
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    await usdc.write.mint([alice.account.address, USDC(10000)]);
    await usdc.write.mint([bob.account.address, USDC(10000)]);
    await usdc.write.mint([attacker.account.address, USDC(10000)]);
    await sayso.write.mint([alice.account.address, SAYSO(1000)]);
    await sayso.write.mint([bob.account.address, SAYSO(1000)]);

    return { usdc, sayso, oracle, factory, market, marketAddress,
      effectiveFrom, effectiveTo, resolutionOpen, resolutionClose };
  }

  // ───────────────────────────────────────────
  // Double claim prevention
  // ───────────────────────────────────────────

  it("user cannot claim twice", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await market.write.claim({ account: alice.account });

    // Second claim should revert
    await assert.rejects(
      market.write.claim({ account: alice.account }),
      (err: any) => err instanceof Error,
      "Should revert on double claim"
    );
  });

  // ───────────────────────────────────────────
  // Non-participant can't claim
  // ───────────────────────────────────────────

  it("user who didn't participate gets 0 claimable", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    // Attacker didn't bet — should get 0
    const claimable = await market.read.calculateClaim([attacker.account.address]);
    assert.equal(claimable, 0n, "Non-participant should have 0 claimable");

    // Trying to claim should revert
    await assert.rejects(
      market.write.claim({ account: attacker.account }),
      (err: any) => err instanceof Error,
      "Non-participant claim should revert"
    );
  });

  // ───────────────────────────────────────────
  // Can't claim before resolution
  // ───────────────────────────────────────────

  it("cannot claim from oracle market before resolution", async function () {
    const { usdc, market } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Try to claim during trading period
    await assert.rejects(
      market.write.claim({ account: alice.account }),
      (err: any) => err instanceof Error,
      "Should not be able to claim before resolution"
    );
  });

  it("cannot claim from voting market before resolutionClose", async function () {
    const { usdc, market } = await deployVotingMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    // Try to claim during trading period
    await assert.rejects(
      market.write.claim({ account: alice.account }),
      (err: any) => err instanceof Error,
      "Should not be able to claim before resolutionClose"
    );
  });

  // ───────────────────────────────────────────
  // Only resolver can resolve oracle markets
  // ───────────────────────────────────────────

  it("attacker cannot resolve oracle market (only resolver)", async function () {
    const { market, effectiveTo } = await deployOracleMarket();

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // Attacker tries to resolve
    await assert.rejects(
      market.write.resolveAsOracle(
        [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
        { account: attacker.account }
      ),
      (err: any) => err instanceof Error,
      "Only resolver should be able to resolve oracle market"
    );
  });

  it("cannot use resolve() on oracle market", async function () {
    const { market, resolutionClose } = await deployOracleMarket();

    const now = await getNow();
    await advanceTime(resolutionClose - now + 1);

    await assert.rejects(
      market.write.resolve(),
      (err: any) => err instanceof Error,
      "resolve() should revert on oracle markets"
    );
  });

  it("cannot use resolveAsOracle() on voting market", async function () {
    const { market, effectiveTo } = await deployVotingMarket();

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await assert.rejects(
      market.write.resolveAsOracle(
        [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
        { account: deployer.account }
      ),
      (err: any) => err instanceof Error,
      "resolveAsOracle should revert on voting markets"
    );
  });

  // ───────────────────────────────────────────
  // Cannot resolve before trading ends
  // ───────────────────────────────────────────

  it("cannot resolve oracle market before effectiveTo", async function () {
    const { market } = await deployOracleMarket();

    // Still during trading period
    await assert.rejects(
      market.write.resolveAsOracle(
        [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
        { account: deployer.account }
      ),
      (err: any) => err instanceof Error,
      "Cannot resolve before trading ends"
    );
  });

  // ───────────────────────────────────────────
  // Flash loan protection
  // ───────────────────────────────────────────

  it("cannot buy and sell in same block (flash loan protection)", async function () {
    const { usdc, market } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    const shares = await market.read.yesBalances([alice.account.address]);

    // Try to sell immediately — should revert
    await assert.rejects(
      market.write.sellYes([shares], { account: alice.account }),
      /Must wait before selling/,
      "Should enforce flash loan protection"
    );
  });

  it("can sell after MIN_HOLD_BLOCKS", async function () {
    const { usdc, market } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await mineBlocks(10);

    const shares = await market.read.yesBalances([alice.account.address]);
    // Should succeed after 10 blocks
    await market.write.sellYes([shares / 2n], { account: alice.account });
    const remaining = await market.read.yesBalances([alice.account.address]);
    assert.equal(remaining, shares - shares / 2n);
  });

  // ───────────────────────────────────────────
  // Trading period enforcement
  // ───────────────────────────────────────────

  it("cannot buy YES after trading period", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await assert.rejects(
      market.write.buyYes([USDC(50)], { account: alice.account }),
      /Trading outside effective period/
    );
  });

  it("cannot buy NO after trading period", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await assert.rejects(
      market.write.buyNo([USDC(50)], { account: alice.account }),
      /Trading outside effective period/
    );
  });

  it("cannot sell YES after trading period", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await mineBlocks(10);

    const now2 = await getNow();
    await advanceTime(effectiveTo - now2 + 1);

    const shares = await market.read.yesBalances([alice.account.address]);
    await assert.rejects(
      market.write.sellYes([shares], { account: alice.account }),
      /Trading outside effective period/
    );
  });

  it("cannot sell NO after trading period", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyNo([USDC(50)], { account: alice.account });

    await mineBlocks(10);

    const now2 = await getNow();
    await advanceTime(effectiveTo - now2 + 1);

    const shares = await market.read.noBalances([alice.account.address]);
    await assert.rejects(
      market.write.sellNo([shares], { account: alice.account }),
      /Trading outside effective period/
    );
  });

  // ───────────────────────────────────────────
  // Cannot resolve twice
  // ───────────────────────────────────────────

  it("cannot resolve oracle market twice", async function () {
    const { market, effectiveTo } = await deployOracleMarket();

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    await assert.rejects(
      market.write.resolveAsOracle(
        [false, "0x0000000000000000000000000000000000000000000000000000000000000002"],
        { account: deployer.account }
      ),
      /Already resolved/,
      "Cannot resolve twice"
    );
  });

  // ───────────────────────────────────────────
  // Minimum deposit enforcement
  // ───────────────────────────────────────────

  it("rejects deposits below MIN_DEPOSIT (1 USDC)", async function () {
    const { usdc, market } = await deployOracleMarket();
    await advanceTime(2);

    // Try to buy with 0.5 USDC (500000 wei, below 1e6 minimum)
    const smallAmount = parseUnits("0.5", 6);
    await usdc.write.approve([market.address, smallAmount], { account: alice.account });
    await assert.rejects(
      market.write.buyYes([smallAmount], { account: alice.account }),
      /Deposit below minimum/
    );
  });

  // ───────────────────────────────────────────
  // Can't sell more shares than you have
  // ───────────────────────────────────────────

  it("cannot sell more shares than balance", async function () {
    const { usdc, market } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await mineBlocks(10);

    const shares = await market.read.yesBalances([alice.account.address]);
    await assert.rejects(
      market.write.sellYes([shares + 1n], { account: alice.account }),
      (err: any) => err instanceof Error,
      "Cannot sell more than balance"
    );
  });

  // ───────────────────────────────────────────
  // Loser gets 0
  // ───────────────────────────────────────────

  it("loser gets exactly 0 claimable", async function () {
    const { usdc, market, effectiveTo } = await deployOracleMarket();
    await advanceTime(2);

    await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
    await market.write.buyYes([USDC(50)], { account: alice.account });

    await usdc.write.approve([market.address, USDC(50)], { account: bob.account });
    await market.write.buyNo([USDC(50)], { account: bob.account });

    const now = await getNow();
    await advanceTime(effectiveTo - now + 1);

    // YES wins
    await market.write.resolveAsOracle(
      [true, "0x0000000000000000000000000000000000000000000000000000000000000001"],
      { account: deployer.account }
    );

    const bobClaimable = await market.read.calculateClaim([bob.account.address]);
    assert.equal(bobClaimable, 0n, "Loser should get exactly 0");
  });
});
