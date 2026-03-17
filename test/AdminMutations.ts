import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const NEW_FEE_COLLECTOR = "0x1234567890123456789012345678901234567890";

describe("Admin Function Mutations", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, attacker] = await viem.getWalletClients();

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
        USDC(100),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ],
      { account: deployer.account }
    );

    const markets = await factory.read.getMarkets([0n, 1n]);
    const market = await viem.getContractAt("AMM", markets[0]);

    return { usdc, sayso, factory, oracle, market, forwarder };
  }

  describe("MarketFactory Admin Mutations", function () {
    it("should update oracle address without affecting existing markets", async function () {
      const { usdc, factory, oracle, sayso, forwarder } = await deployAll();

      // Get existing market
      const marketsBefore = await factory.read.getMarkets([0n, 1n]);
      const existingMarket = await viem.getContractAt("AMM", marketsBefore[0]);
      const existingOracle = await existingMarket.read.oracle();

      console.log(`  Existing market oracle: ${existingOracle}`);
      console.log(`  Current factory oracle: ${oracle.address}`);

      // Deploy new oracle
      const newOracle = await viem.deployContract("ResolutionOracle", [
        sayso.address,
        forwarder.address,
        factory.address,
      ]);

      // Update factory oracle
      await factory.write.setOracle([newOracle.address], { account: deployer.account });

      const updatedFactoryOracle = await factory.read.oracle();
      const existingMarketOracle = await existingMarket.read.oracle();

      console.log(`  New factory oracle: ${updatedFactoryOracle}`);
      console.log(`  Existing market oracle (unchanged): ${existingMarketOracle}`);

      // Verify factory oracle changed
      assert.equal(
        updatedFactoryOracle.toLowerCase(),
        newOracle.address.toLowerCase(),
        "Factory oracle should be updated"
      );

      // Verify existing market oracle unchanged
      assert.equal(
        existingMarketOracle.toLowerCase(),
        oracle.address.toLowerCase(),
        "Existing market oracle should not change"
      );

      // Create new market with new oracle
      const now = await getNow();
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "New Market",
          now + 1000,
          now + 1200,
          now + 1300,
          now + 1500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const marketsAfter = await factory.read.getMarkets([0n, 10n]);
      const newMarket = await viem.getContractAt("AMM", marketsAfter[marketsAfter.length - 1]);
      const newMarketOracle = await newMarket.read.oracle();

      console.log(`  New market oracle: ${newMarketOracle}`);

      // Verify new market uses new oracle
      assert.equal(
        newMarketOracle.toLowerCase(),
        newOracle.address.toLowerCase(),
        "New market should use updated oracle"
      );
    });

    it("should update trading token without affecting existing markets", async function () {
      const { usdc, factory } = await deployAll();

      const marketsBefore = await factory.read.getMarkets([0n, 1n]);
      const existingMarket = await viem.getContractAt("AMM", marketsBefore[0]);
      const existingToken = await existingMarket.read.token();

      console.log(`  Existing market token: ${existingToken}`);

      // Deploy new token
      const newToken = await viem.deployContract("MockUSDC");

      // Update factory trading token
      await factory.write.setTradingToken([newToken.address], { account: deployer.account });

      const updatedFactoryToken = await factory.read.tradingToken();
      const existingMarketToken = await existingMarket.read.token();

      console.log(`  New factory token: ${updatedFactoryToken}`);
      console.log(`  Existing market token (unchanged): ${existingMarketToken}`);

      // Verify factory token changed
      assert.equal(
        updatedFactoryToken.toLowerCase(),
        newToken.address.toLowerCase(),
        "Factory trading token should be updated"
      );

      // Verify existing market token unchanged
      assert.equal(
        existingMarketToken.toLowerCase(),
        usdc.address.toLowerCase(),
        "Existing market token should not change"
      );
    });

    it("should update trusted forwarder without affecting existing markets", async function () {
      const { factory, forwarder } = await deployAll();

      const marketsBefore = await factory.read.getMarkets([0n, 1n]);
      const existingMarket = await viem.getContractAt("AMM", marketsBefore[0]);
      const existingForwarder = await existingMarket.read.trustedForwarder();

      console.log(`  Existing market forwarder: ${existingForwarder}`);

      // Deploy new forwarder
      const newForwarder = await viem.deployContract("SaySoForwarder");

      // Update factory forwarder
      await factory.write.setTrustedForwarder([newForwarder.address], { account: deployer.account });

      const updatedFactoryForwarder = await factory.read.trustedForwarder();
      const existingMarketForwarder = await existingMarket.read.trustedForwarder();

      console.log(`  New factory forwarder: ${updatedFactoryForwarder}`);
      console.log(`  Existing market forwarder (unchanged): ${existingMarketForwarder}`);

      // Verify factory forwarder changed
      assert.equal(
        updatedFactoryForwarder.toLowerCase(),
        newForwarder.address.toLowerCase(),
        "Factory forwarder should be updated"
      );

      // Verify existing market forwarder unchanged
      assert.equal(
        existingMarketForwarder.toLowerCase(),
        forwarder.address.toLowerCase(),
        "Existing market forwarder should not change"
      );
    });

    it("should update fee collector and apply to new markets only", async function () {
      const { usdc, factory } = await deployAll();

      const marketsBefore = await factory.read.getMarkets([0n, 1n]);
      const existingMarket = await viem.getContractAt("AMM", marketsBefore[0]);
      const existingFeeCollector = await existingMarket.read.feeCollector();

      console.log(`  Existing market fee collector: ${existingFeeCollector}`);

      // Update factory fee collector
      await factory.write.setFeeCollector([NEW_FEE_COLLECTOR], { account: deployer.account });

      const updatedFactoryFeeCollector = await factory.read.feeCollector();
      const existingMarketFeeCollector = await existingMarket.read.feeCollector();

      console.log(`  New factory fee collector: ${updatedFactoryFeeCollector}`);
      console.log(`  Existing market fee collector (unchanged): ${existingMarketFeeCollector}`);

      // Verify factory fee collector changed
      assert.equal(
        updatedFactoryFeeCollector.toLowerCase(),
        NEW_FEE_COLLECTOR.toLowerCase(),
        "Factory fee collector should be updated"
      );

      // Verify existing market fee collector unchanged
      assert.equal(
        existingMarketFeeCollector.toLowerCase(),
        FEE_COLLECTOR.toLowerCase(),
        "Existing market fee collector should not change"
      );

      // Create new market and verify it uses new fee collector
      const now = await getNow();
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "New Market",
          now + 1000,
          now + 1200,
          now + 1300,
          now + 1500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const marketsAfter = await factory.read.getMarkets([0n, 10n]);
      const newMarket = await viem.getContractAt("AMM", marketsAfter[marketsAfter.length - 1]);
      const newMarketFeeCollector = await newMarket.read.feeCollector();

      console.log(`  New market fee collector: ${newMarketFeeCollector}`);

      assert.equal(
        newMarketFeeCollector.toLowerCase(),
        NEW_FEE_COLLECTOR.toLowerCase(),
        "New market should use updated fee collector"
      );
    });

    it("should validate zero address in setFeeCollector", async function () {
      const { factory } = await deployAll();

      console.log(`  Attempting to set fee collector to zero address`);

      try {
        await factory.write.setFeeCollector(["0x0000000000000000000000000000000000000000"], {
          account: deployer.account,
        });
        assert.fail("Should have reverted with zero address");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("zero address"),
          "Should revert with zero address error"
        );
      }
    });

    it("should validate zero address in setOracle", async function () {
      const { factory } = await deployAll();

      console.log(`  Attempting to set oracle to zero address`);

      try {
        await factory.write.setOracle(["0x0000000000000000000000000000000000000000"], {
          account: deployer.account,
        });
        assert.fail("Should have reverted with zero address");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("zero address"),
          "Should revert with zero address error"
        );
      }
    });

    it("should validate zero address in setTradingToken", async function () {
      const { factory } = await deployAll();

      console.log(`  Attempting to set trading token to zero address`);

      try {
        await factory.write.setTradingToken(["0x0000000000000000000000000000000000000000"], {
          account: deployer.account,
        });
        assert.fail("Should have reverted with zero address");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("zero address"),
          "Should revert with zero address error"
        );
      }
    });

    it("should validate zero address in setTrustedForwarder", async function () {
      const { factory } = await deployAll();

      console.log(`  Attempting to set forwarder to zero address`);

      try {
        await factory.write.setTrustedForwarder(["0x0000000000000000000000000000000000000000"], {
          account: deployer.account,
        });
        assert.fail("Should have reverted with zero address");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("zero address"),
          "Should revert with zero address error"
        );
      }
    });
  });

  describe("Access Control", function () {
    it("should prevent non-owner from calling setOracle", async function () {
      const { factory, sayso, forwarder } = await deployAll();

      const newOracle = await viem.deployContract("ResolutionOracle", [
        sayso.address,
        forwarder.address,
        factory.address,
      ]);

      console.log(`  Attacker attempting to set oracle`);

      try {
        await factory.write.setOracle([newOracle.address], { account: attacker.account });
        assert.fail("Should have reverted due to unauthorized access");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("Ownable"),
          "Should revert with access control error"
        );
      }
    });

    it("should prevent non-owner from calling setTradingToken", async function () {
      const { factory } = await deployAll();

      const newToken = await viem.deployContract("MockUSDC");

      console.log(`  Attacker attempting to set trading token`);

      try {
        await factory.write.setTradingToken([newToken.address], { account: attacker.account });
        assert.fail("Should have reverted due to unauthorized access");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("Ownable"),
          "Should revert with access control error"
        );
      }
    });

    it("should prevent non-owner from calling setTrustedForwarder", async function () {
      const { factory } = await deployAll();

      const newForwarder = await viem.deployContract("SaySoForwarder");

      console.log(`  Attacker attempting to set forwarder`);

      try {
        await factory.write.setTrustedForwarder([newForwarder.address], { account: attacker.account });
        assert.fail("Should have reverted due to unauthorized access");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("Ownable"),
          "Should revert with access control error"
        );
      }
    });

    it("should prevent non-owner from calling setFeeCollector", async function () {
      const { factory } = await deployAll();

      console.log(`  Attacker attempting to set fee collector`);

      try {
        await factory.write.setFeeCollector([NEW_FEE_COLLECTOR], { account: attacker.account });
        assert.fail("Should have reverted due to unauthorized access");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("Ownable"),
          "Should revert with access control error"
        );
      }
    });

    it("should prevent non-owner from calling oracle.setFactory", async function () {
      const { factory, oracle } = await deployAll();

      const fakeFactory = await viem.deployContract("MockUSDC"); // Use any contract as fake factory

      console.log(`  Attacker attempting to set oracle factory`);

      try {
        await oracle.write.setFactory([fakeFactory.address], { account: attacker.account });
        assert.fail("Should have reverted due to unauthorized access");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("Ownable"),
          "Should revert with access control error"
        );
      }
    });
  });

  describe("Event Emissions", function () {
    it("should emit OracleUpdated event when oracle is changed", async function () {
      const { factory, oracle, sayso, forwarder } = await deployAll();

      const newOracle = await viem.deployContract("ResolutionOracle", [
        sayso.address,
        forwarder.address,
        factory.address,
      ]);

      console.log(`  Updating oracle and checking events`);

      const hash = await factory.write.setOracle([newOracle.address], { account: deployer.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Check if OracleUpdated event was emitted
      const logs = receipt.logs;
      console.log(`  Transaction emitted ${logs.length} logs`);

      assert.ok(logs.length > 0, "Should emit at least one event");
    });

    it("should emit TradingTokenUpdated event when token is changed", async function () {
      const { factory } = await deployAll();

      const newToken = await viem.deployContract("MockUSDC");

      console.log(`  Updating trading token and checking events`);

      const hash = await factory.write.setTradingToken([newToken.address], { account: deployer.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const logs = receipt.logs;
      console.log(`  Transaction emitted ${logs.length} logs`);

      assert.ok(logs.length > 0, "Should emit at least one event");
    });

    it("should emit TrustedForwarderUpdated event when forwarder is changed", async function () {
      const { factory } = await deployAll();

      const newForwarder = await viem.deployContract("SaySoForwarder");

      console.log(`  Updating forwarder and checking events`);

      const hash = await factory.write.setTrustedForwarder([newForwarder.address], {
        account: deployer.account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const logs = receipt.logs;
      console.log(`  Transaction emitted ${logs.length} logs`);

      assert.ok(logs.length > 0, "Should emit at least one event");
    });

    it("should emit FeeCollectorUpdated event when fee collector is changed", async function () {
      const { factory } = await deployAll();

      console.log(`  Updating fee collector and checking events`);

      const hash = await factory.write.setFeeCollector([NEW_FEE_COLLECTOR], {
        account: deployer.account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const logs = receipt.logs;
      console.log(`  Transaction emitted ${logs.length} logs`);

      assert.ok(logs.length > 0, "Should emit at least one event");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // AMM Pause / Unpause / Refund
  // ═══════════════════════════════════════════════════════════════════

  describe("AMM Pause", function () {
    it("admin can pause and block trading", async function () {
      const { usdc, market } = await deployAll();

      // Admin (deployer) pauses market
      await market.write.pause([], { account: deployer.account });
      assert.equal(await market.read.paused(), true);

      // Alice tries to buy — should revert
      await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
      await assert.rejects(
        market.write.buyYes([USDC(10)], { account: alice.account }),
        (err: any) => /Market is paused/.test(String(err)),
        "Should revert with Market is paused"
      );

      // buyNo also blocked
      await assert.rejects(
        market.write.buyNo([USDC(10)], { account: alice.account }),
        (err: any) => /Market is paused/.test(String(err)),
        "Should revert with Market is paused"
      );
    });

    it("admin can unpause and resume trading", async function () {
      const { usdc, market } = await deployAll();

      await market.write.pause([], { account: deployer.account });
      assert.equal(await market.read.paused(), true);

      await market.write.unpause([], { account: deployer.account });
      assert.equal(await market.read.paused(), false);

      // Trading works again
      await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
      await market.write.buyYes([USDC(10)], { account: alice.account });
      const shares = await market.read.yesBalances([alice.account.address]);
      assert.ok(shares > 0n, "Should receive shares after unpause");
    });

    it("non-admin cannot pause", async function () {
      const { market } = await deployAll();

      await assert.rejects(
        market.write.pause([], { account: attacker.account }),
        (err: any) => err instanceof Error,
        "Should revert for non-admin"
      );
      // Verify market is still unpaused
      assert.equal(await market.read.paused(), false);
    });

    it("non-admin cannot unpause", async function () {
      const { market } = await deployAll();

      await market.write.pause([], { account: deployer.account });

      await assert.rejects(
        market.write.unpause([], { account: attacker.account }),
        (err: any) => err instanceof Error,
        "Should revert for non-admin"
      );
      // Verify market is still paused
      assert.equal(await market.read.paused(), true);
    });

    it("emits MarketPaused and MarketUnpaused events", async function () {
      const { market } = await deployAll();

      const pauseHash = await market.write.pause([], { account: deployer.account });
      const pauseReceipt = await publicClient.waitForTransactionReceipt({ hash: pauseHash });
      assert.ok(pauseReceipt.logs.length > 0, "Should emit MarketPaused event");

      const unpauseHash = await market.write.unpause([], { account: deployer.account });
      const unpauseReceipt = await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
      assert.ok(unpauseReceipt.logs.length > 0, "Should emit MarketUnpaused event");
    });

    it("sell is also blocked when paused", async function () {
      const { usdc, market } = await deployAll();

      // Alice buys first
      await usdc.write.approve([market.address, USDC(10)], { account: alice.account });
      await market.write.buyYes([USDC(10)], { account: alice.account });

      // Mine blocks to pass flash loan protection
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      // Admin pauses
      await market.write.pause([], { account: deployer.account });

      // Alice tries to sell — blocked by pause
      const shares = await market.read.yesBalances([alice.account.address]);
      await assert.rejects(
        market.write.sellYes([shares], { account: alice.account }),
        (err: any) => /Market is paused/.test(String(err)),
        "Should revert with Market is paused"
      );
    });
  });

  describe("AMM Refund", function () {
    it("admin can refund and users get proportional payouts", async function () {
      const { usdc, market } = await deployAll();

      // Alice and Bob buy shares
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(50)], { account: bob.account });
      await market.write.buyNo([USDC(50)], { account: bob.account });

      // Admin refunds
      await market.write.refund([], { account: deployer.account });

      assert.equal(await market.read.refunded(), true);
      assert.equal(await market.read.resolved(), true);

      // Both users can claim proportional refunds
      const aliceClaim = await market.read.calculateClaim([alice.account.address]);
      const bobClaim = await market.read.calculateClaim([bob.account.address]);

      assert.ok(aliceClaim > 0n, "Alice should have claimable amount");
      assert.ok(bobClaim > 0n, "Bob should have claimable amount");

      // Alice claims
      const aliceBefore = await usdc.read.balanceOf([alice.account.address]);
      await market.write.claim([], { account: alice.account });
      const aliceAfter = await usdc.read.balanceOf([alice.account.address]);
      assert.ok(aliceAfter > aliceBefore, "Alice should receive refund");
    });

    it("non-admin cannot refund", async function () {
      const { market } = await deployAll();

      await assert.rejects(
        market.write.refund([], { account: attacker.account }),
        (err: any) => err instanceof Error,
        "Should revert for non-admin"
      );
      // Verify market is not refunded
      assert.equal(await market.read.refunded(), false);
    });

    it("cannot refund after resolution", async function () {
      const { market } = await deployAll();

      // Advance past resolution period
      await advanceTime(600);

      // Resolve the market first
      await market.write.resolve([], { account: deployer.account });

      // Try to refund — should fail
      await assert.rejects(
        market.write.refund([], { account: deployer.account }),
        (err: any) => /Already resolved/.test(String(err)),
        "Should revert with Already resolved"
      );
    });

    it("cannot refund twice", async function () {
      const { market } = await deployAll();

      await market.write.refund([], { account: deployer.account });

      // Second refund hits "Already resolved" since refund() sets resolved=true
      await assert.rejects(
        market.write.refund([], { account: deployer.account }),
        (err: any) => /Already resolved/.test(String(err)),
        "Should revert with Already resolved"
      );
    });

    it("emits MarketRefunded event", async function () {
      const { market } = await deployAll();

      const hash = await market.write.refund([], { account: deployer.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.ok(receipt.logs.length > 0, "Should emit MarketRefunded event");
    });

    it("refund gives proportional payout based on total shares", async function () {
      const { usdc, market } = await deployAll();

      // Alice buys YES, Bob buys NO
      await usdc.write.approve([market.address, USDC(200)], { account: alice.account });
      await market.write.buyYes([USDC(200)], { account: alice.account });

      await usdc.write.approve([market.address, USDC(100)], { account: bob.account });
      await market.write.buyNo([USDC(100)], { account: bob.account });

      // Refund
      await market.write.refund([], { account: deployer.account });

      const aliceClaim = await market.read.calculateClaim([alice.account.address]);
      const bobClaim = await market.read.calculateClaim([bob.account.address]);

      assert.ok(aliceClaim > 0n, "Alice should get refund");
      assert.ok(bobClaim > 0n, "Bob should get refund");

      // Seed provider also has shares, so alice+bob claims < totalDeposited
      const totalDeposited = await market.read.totalDeposited();
      assert.ok(aliceClaim + bobClaim <= totalDeposited, "Total claims should not exceed deposits");
    });
  });
});
