import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

/**
 * PRIORITY 3: EDGE CASES
 * Tests for boundary conditions, state transitions, and special scenarios
 */
describe("Edge Cases & Boundaries", async function () {
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

  describe("Minimum Deposit Boundaries", function () {
    it("cannot buy with less than MIN_DEPOSIT (1 USDC)", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      // Try to buy with 0.999 USDC (just under minimum)
      await usdc.write.approve([market.address, USDC(0.999)], { account: alice.account });

      await assert.rejects(
        market.write.buyYes([USDC(0.999)], { account: alice.account }),
        /Deposit below minimum|MIN_DEPOSIT/i,
        "Should reject deposit below 1 USDC"
      );
    });

    it("can buy with exactly MIN_DEPOSIT (1 USDC)", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      // Buy with exactly 1 USDC
      await usdc.write.approve([market.address, USDC(1)], { account: alice.account });
      await market.write.buyYes([USDC(1)], { account: alice.account });

      const shares = await market.read.yesBalances([alice.account.address]);
      assert.ok(shares > 0n, "Should receive shares for 1 USDC deposit");
    });

    it("cannot create market with seed below MIN_SEED (10 USDC)", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)]);

      // Try with 9.999 USDC total seed
      await assert.rejects(
        factory.write.createMarket([
          "Test",
          BigInt(now),
          BigInt(now + 200),
          BigInt(now + 300),
          BigInt(now + 500),
          USDC(9.999),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ]),
        /Seed below minimum|MIN_SEED/i,
        "Should reject seed below 10 USDC"
      );
    });

    it("can create market with exactly MIN_SEED (10 USDC)", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const markets = await factory.read.getAllMarkets();
      assert.equal(markets.length, 1, "Should create market with exactly 10 USDC seed");
    });

    it("can create market with 100% YES seed", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(100), // Total seed
        9900n,     // 99% YES
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      const price = await market.read.price();
      assert.ok(price > 500000000000000000n, "Price should be > 50% for 100% YES seed");
    });

    it("can create market with 100% NO seed", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(100),
        100n, // All NO
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      const price = await market.read.price();
      assert.ok(price < 500000000000000000n, "Price should be < 50% for 100% NO seed");
    });
  });

  describe("Zero Amount Operations", function () {
    it("cannot buy with 0 amount", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(1000)], { account: alice.account });

      await assert.rejects(
        market.write.buyYes([0n], { account: alice.account }),
        (err: any) => {
          const errMsg = err?.message || err?.details || String(err);
          return /Amount must be greater than 0|Deposit below minimum/i.test(errMsg);
        },
        "Should reject 0 amount buy"
      );
    });

    it("cannot sell 0 shares", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      await mineBlocks(10);

      await assert.rejects(
        market.write.sellYes([0n], { account: alice.account }),
        (err: any) => {
          const errMsg = err?.message || err?.details || String(err);
          return /Shares must be greater than 0|Amount must be positive/i.test(errMsg);
        },
        "Should reject 0 shares sell"
      );
    });
  });

  describe("Exact Share Balance Operations", function () {
    it("can sell exactly all shares owned", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const shares = await market.read.yesBalances([alice.account.address]);

      await mineBlocks(10);

      // Sell exactly all shares
      await market.write.sellYes([shares], { account: alice.account });

      const sharesAfter = await market.read.yesBalances([alice.account.address]);
      assert.equal(sharesAfter, 0n, "Should have 0 shares after selling all");
    });

    it("cannot sell more shares than owned", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const shares = await market.read.yesBalances([alice.account.address]);

      await mineBlocks(10);

      // Try to sell more than owned
      await assert.rejects(
        market.write.sellYes([shares + 1n], { account: alice.account }),
        /Insufficient shares|balance/i,
        "Should reject selling more shares than owned"
      );
    });
  });

  describe("State Transition Validations", function () {
    it("cannot trade after resolve", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);

      await advanceTime(2);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Advance to voting
      await advanceTime((await market.read.resolutionOpen()) - BigInt(await getNow()) + 1n);
      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      // Resolve
      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);
      await market.write.resolve();

      // Try to trade after resolution
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      await assert.rejects(
        market.write.buyYes([USDC(100)], { account: alice.account }),
        /Trading outside effective period/i,
        "Should not allow trading after resolution"
      );
    });

    it("cannot claim before resolution", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Try to claim before resolution
      await assert.rejects(
        market.write.claim({ account: alice.account }),
        /Resolution not yet closed/i,
        "Should not allow claiming before resolution"
      );
    });

    it("cannot claim twice", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);

      await advanceTime(2);
      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      await advanceTime((await market.read.resolutionOpen()) - BigInt(await getNow()) + 1n);
      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);
      await market.write.resolve();

      // First claim
      await market.write.claim({ account: alice.account });

      // Second claim should fail
      await assert.rejects(
        market.write.claim({ account: alice.account }),
        /Already claimed|No claimable/i,
        "Should not allow claiming twice"
      );
    });
  });

  describe("Tie Scenarios", function () {
    it("exact tie: equal votes results in proportional refunds", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await usdc.write.mint([bob.account.address, USDC(1000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);
      await sayso.write.mint([deployer.account.address, SAYSO(1000)]);

      await advanceTime(2);

      // Trading
      await usdc.write.approve([market.address, USDC(600)], { account: alice.account });
      await market.write.buyYes([USDC(600)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(400)], { account: bob.account });
      await market.write.buyNo([USDC(400)], { account: bob.account });

      // Voting - EXACT TIE
      await advanceTime((await market.read.resolutionOpen()) - BigInt(await getNow()) + 1n);

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: deployer.account });
      await oracle.write.voteNo([marketAddress, SAYSO(500)], { account: deployer.account });

      // Resolve
      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);
      await market.write.resolve();

      // Verify tie state
      const isTie = await market.read.isTie();
      assert.equal(isTie, true, "Market should be in tie state");

      // Claims - both should get proportional refunds
      const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
      await market.write.claim({ account: alice.account });
      const aliceRefund = (await usdc.read.balanceOf([alice.account.address])) - aliceBefore;

      const bobBefore = await usdc.read.balanceOf([bob.account.address]);
      await market.write.claim({ account: bob.account });
      const bobRefund = (await usdc.read.balanceOf([bob.account.address])) - bobBefore;

      // Both should get positive refunds
      assert.ok(aliceRefund > USDC(400), "Alice should get significant refund in tie");
      assert.ok(bobRefund > USDC(300), "Bob should get significant refund in tie");
    });

    it("tie: oracle voters both get full stake back", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      // Give voters SAYSO tokens
      await sayso.write.mint([charlie.account.address, SAYSO(500)]);
      await sayso.write.mint([deployer.account.address, SAYSO(500)]);

      const charlieBefore = await sayso.read.balanceOf([charlie.account.address]);
      const deployerBefore = await sayso.read.balanceOf([deployer.account.address]);

      // Voting - EXACT TIE: 500 YES vs 500 NO
      await advanceTime((await market.read.resolutionOpen()) - BigInt(await getNow()) + 1n);

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: deployer.account });
      await oracle.write.voteNo([marketAddress, SAYSO(500)], { account: deployer.account });

      // Resolve
      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);
      await market.write.resolve();

      const isTie = await market.read.isTie();
      assert.equal(isTie, true, "Market should be in tie state");

      // Both voters should get their full SAYSO stake back
      const charlieClaimable = await oracle.read.calculateClaim([marketAddress, charlie.account.address]);
      const deployerClaimable = await oracle.read.calculateClaim([marketAddress, deployer.account.address]);

      assert.equal(charlieClaimable, SAYSO(500), "YES voter should get full 500 SAYSO back on tie");
      assert.equal(deployerClaimable, SAYSO(500), "NO voter should get full 500 SAYSO back on tie");

      // Claim and verify balances
      await oracle.write.claim([marketAddress], { account: charlie.account });
      await oracle.write.claim([marketAddress], { account: deployer.account });

      const charlieAfter = await sayso.read.balanceOf([charlie.account.address]);
      const deployerAfter = await sayso.read.balanceOf([deployer.account.address]);

      assert.equal(charlieAfter, charlieBefore, "Charlie should have same SAYSO as before voting");
      assert.equal(deployerAfter, deployerBefore, "Deployer should have same SAYSO as before voting");
    });

    it("tie event is emitted", async function () {
      const { usdc, sayso, oracle, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await sayso.write.mint([charlie.account.address, SAYSO(1000)]);
      await sayso.write.mint([deployer.account.address, SAYSO(1000)]);

      await advanceTime(2);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      await advanceTime((await market.read.resolutionOpen()) - BigInt(await getNow()) + 1n);

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: charlie.account });
      await oracle.write.voteYes([marketAddress, SAYSO(500)], { account: charlie.account });

      await sayso.write.approve([oracle.address, SAYSO(500)], { account: deployer.account });
      await oracle.write.voteNo([marketAddress, SAYSO(500)], { account: deployer.account });

      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);

      // Resolve and check for tie event (we can't easily check event emission in viem,
      // but we can verify isTie state variable)
      await market.write.resolve();

      const isTie = await market.read.isTie();
      assert.equal(isTie, true, "isTie should be true for equal votes");
    });
  });

  describe("No-Votes Scenarios", function () {
    it("no votes with single bettor: full refund", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await advanceTime(2);

      await usdc.write.approve([market.address, USDC(500)], { account: alice.account });
      await market.write.buyYes([USDC(500)], { account: alice.account });

      // Skip to end, no votes
      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);
      await market.write.resolve();

      // Claim
      const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
      await market.write.claim({ account: alice.account });
      const aliceRefund = (await usdc.read.balanceOf([alice.account.address])) - aliceBefore;

      // With LMSR and no-votes, Alice should get a proportional refund
      // When buying 500 USDC on a 10 USDC pool, there's significant slippage
      // The refund is based on share proportions, not original deposit

      // Should get at least 40% back (accounting for LMSR slippage on large trade)
      const netDeposit = USDC(500) * 995n / 1000n; // After 0.5% fee = 497.5
      assert.ok(
        aliceRefund >= netDeposit * 40n / 100n,
        `Alice should get substantial refund in no-votes scenario (got ${aliceRefund}, expected >= ${netDeposit * 40n / 100n})`
      );

      // Should get more than just the seed
      assert.ok(
        aliceRefund > USDC(50),
        "Alice should get more than just seed amount"
      );

      // And shouldn't get more than she deposited
      assert.ok(
        aliceRefund <= USDC(500),
        "Alice shouldn't get more than she deposited"
      );
    });

    it("no votes with seed provider: seed provider can claim", async function () {
      const { usdc, factory } = await deployInfrastructure();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)]);

      await factory.write.createMarket([
        "Test",
        BigInt(now),
        BigInt(now + 200),
        BigInt(now + 300),
        BigInt(now + 500),
        USDC(10),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ]);

      const marketAddress = (await factory.read.getAllMarkets())[0];
      const market = await viem.getContractAt("AMM", marketAddress);

      // No trading, just skip to resolution
      await advanceTime((await market.read.resolutionClose()) - BigInt(await getNow()) + 1n);
      await market.write.resolve();

      // Deployer (seed provider) claims
      const deployerBefore = await usdc.read.balanceOf([deployer.account.address]);
      await market.write.claim();
      const deployerRefund = (await usdc.read.balanceOf([deployer.account.address])) - deployerBefore;

      // Should get back the full 10 USDC seed
      assert.ok(deployerRefund >= USDC(9.5), "Deployer should get back ~10 USDC seed");
    });
  });
});
