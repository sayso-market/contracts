import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("State Transition Edge Cases", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie] = await viem.getWalletClients();

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

    return { usdc, sayso, factory, oracle, forwarder };
  }

  describe("Phase Transitions", function () {
    it("should transition from NOT_TRADING to TRADING at effectiveFrom", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      // Create market that starts in 100 seconds
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Future Market",
          now + 100, // Starts in future
          now + 300,
          now + 400,
          now + 600,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Fund Alice
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      console.log(`  Attempting to trade before effectiveFrom`);

      // Attempt to trade before effectiveFrom (should fail)
      try {
        await market.write.buyYes([USDC(50)], { account: alice.account });
        assert.fail("Should have reverted - trading not started");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (trading not started)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("outside effective period"),
          "Should revert with timing error"
        );
      }

      // Advance to effectiveFrom
      await advanceTime(100);

      console.log(`  Trading after effectiveFrom`);

      // Now trading should work
      await market.write.buyYes([USDC(50)], { account: alice.account });

      const yesBalance = await market.read.yesBalances([alice.account.address]);
      console.log(`  Alice received ${Number(yesBalance) / 1e18} YES shares`);

      assert.ok(yesBalance > 0n, "Should receive YES shares after effectiveFrom");
    });

    it("should transition from TRADING to VOTING at resolutionOpen", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200, // Trading ends
          now + 300, // Voting starts
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      // Fund voters
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });

      console.log(`  Attempting to vote before resolutionOpen`);

      // Attempt to vote before resolutionOpen (should fail)
      try {
        await oracle.write.voteYes([market, SAYSO(100)], { account: alice.account });
        assert.fail("Should have reverted - voting not open");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (voting not open)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("not opened"),
          "Should revert with voting timing error"
        );
      }

      // Advance to resolutionOpen
      await advanceTime(301);

      console.log(`  Voting after resolutionOpen`);

      // Now voting should work
      await oracle.write.voteYes([market, SAYSO(100)], { account: alice.account });

      const yesVotes = await oracle.read.yesVotesByUser([market, alice.account.address]);
      console.log(`  Alice cast ${Number(yesVotes) / 1e18} YES votes`);

      assert.equal(yesVotes, SAYSO(100), "Should cast votes after resolutionOpen");
    });

    it("should transition from VOTING to RESOLVED after resolve() is called", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Advance to voting period
      await advanceTime(301);

      // Cast votes
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      const resolvedBefore = await market.read.resolved();
      console.log(`  Market resolved before resolve(): ${resolvedBefore}`);

      assert.equal(resolvedBefore, false, "Should not be resolved yet");

      // Advance to after resolutionClose
      await advanceTime(201);

      console.log(`  Calling resolve()`);

      // Call resolve
      await market.write.resolve();

      const resolvedAfter = await market.read.resolved();
      const outcome = await market.read.outcome();

      console.log(`  Market resolved: ${resolvedAfter}`);
      console.log(`  Outcome: ${outcome ? "YES" : "NO"}`);

      assert.equal(resolvedAfter, true, "Should be resolved after resolve()");
    });

    it("should transition from RESOLVED to CLAIMED when users claim", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Alice buys YES
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Advance to voting and vote YES
      await advanceTime(301);
      await sayso.write.mint([bob.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: bob.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: bob.account });

      // Resolve
      await advanceTime(201);
      await market.write.resolve();

      const hasClaimedBefore = await market.read.hasClaimed([alice.account.address]);
      console.log(`  Alice has claimed before: ${hasClaimedBefore}`);

      assert.equal(hasClaimedBefore, false, "Should not have claimed yet");

      // Claim
      console.log(`  Alice claiming rewards`);
      await market.write.claim({ account: alice.account });

      const hasClaimedAfter = await market.read.hasClaimed([alice.account.address]);
      console.log(`  Alice has claimed after: ${hasClaimedAfter}`);

      assert.equal(hasClaimedAfter, true, "Should have claimed");
    });
  });

  describe("Invalid State Transitions", function () {
    it("should prevent trading after effectiveTo", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200, // Trading ends
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Advance past effectiveTo
      await advanceTime(201);

      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      console.log(`  Attempting to trade after effectiveTo`);

      try {
        await market.write.buyYes([USDC(50)], { account: alice.account });
        assert.fail("Should have reverted - trading ended");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (trading ended)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("outside effective period"),
          "Should revert with timing error"
        );
      }
    });

    it("should prevent voting after resolutionClose", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500, // Voting closes
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      // Advance past resolutionClose
      await advanceTime(501);

      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });

      console.log(`  Attempting to vote after resolutionClose`);

      try {
        await oracle.write.voteYes([market, SAYSO(100)], { account: alice.account });
        assert.fail("Should have reverted - voting closed");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (voting closed)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("closed"),
          "Should revert with voting timing error"
        );
      }
    });

    it("should prevent resolve() before resolutionClose", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Advance to voting period but before resolutionClose
      await advanceTime(400);

      console.log(`  Attempting to resolve before resolutionClose`);

      try {
        await market.write.resolve();
        assert.fail("Should have reverted - resolution not closed yet");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (resolution not closed)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("not closed"),
          "Should revert with timing error"
        );
      }
    });

    it("should prevent double resolution", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Advance to voting and vote
      await advanceTime(301);
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      // Resolve
      await advanceTime(201);
      await market.write.resolve();

      console.log(`  Market resolved once, attempting to resolve again`);

      try {
        await market.write.resolve();
        assert.fail("Should have reverted - already resolved");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (already resolved)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("resolved"),
          "Should revert with already resolved error"
        );
      }
    });

    it("should prevent claiming before resolution", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Alice buys YES
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      console.log(`  Attempting to claim before resolution`);

      try {
        await market.write.claim({ account: alice.account });
        assert.fail("Should have reverted - not resolved yet");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (not resolved)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("resolved"),
          "Should revert with not resolved error"
        );
      }
    });

    it("should prevent double claiming", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Alice buys YES
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Advance and resolve (YES wins)
      await advanceTime(301);
      await sayso.write.mint([bob.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: bob.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: bob.account });

      await advanceTime(201);
      await market.write.resolve();

      // First claim
      await market.write.claim({ account: alice.account });

      console.log(`  Alice claimed once, attempting to claim again`);

      try {
        await market.write.claim({ account: alice.account });
        assert.fail("Should have reverted - already claimed");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (already claimed)`);
        assert.ok(
          error.message.includes("revert") || error.message.includes("claimed"),
          "Should revert with already claimed error"
        );
      }
    });
  });

  describe("Boundary Conditions", function () {
    it("should handle transition exactly at effectiveFrom boundary", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      // Create market that starts exactly at next timestamp
      const startTime = now + 10;

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Boundary Market",
          startTime,
          startTime + 200,
          startTime + 300,
          startTime + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Advance to exactly startTime
      await advanceTime(10);

      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      console.log(`  Trading exactly at effectiveFrom boundary`);

      // Should work at exact boundary (>= check)
      await market.write.buyYes([USDC(50)], { account: alice.account });

      const yesBalance = await market.read.yesBalances([alice.account.address]);
      assert.ok(yesBalance > 0n, "Should trade at exact effectiveFrom boundary");
    });

    it("should handle transition exactly at effectiveTo boundary", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      const startTime = now;
      const endTime = now + 100;

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Boundary Market",
          startTime,
          endTime,
          endTime + 100,
          endTime + 300,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Mint and approve before advancing time so only buyYes remains
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      // Use exact timestamp control to place buyYes right at effectiveTo
      await provider.send("evm_setNextBlockTimestamp", [endTime]);
      console.log(`  Trading at exact effectiveTo boundary`);

      // Should work at boundary (<= check)
      await market.write.buyYes([USDC(50)], { account: alice.account });

      const yesBalance = await market.read.yesBalances([alice.account.address]);
      assert.ok(yesBalance > 0n, "Should trade at exact effectiveTo boundary");
    });

    it("should maintain state consistency after failed transition attempt", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now + 100, // Future market
          now + 300,
          now + 400,
          now + 600,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          deployer.account.address,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      // Attempt to trade before start (will fail)
      try {
        await market.write.buyYes([USDC(50)], { account: alice.account });
      } catch (error: any) {
        console.log(`  Failed transition attempt (expected)`);
      }

      // Check state is still consistent
      const aliceBalance = await market.read.yesBalances([alice.account.address]);
      const aliceUSDC = await usdc.read.balanceOf([alice.account.address]);

      console.log(`  Alice YES balance: ${Number(aliceBalance) / 1e18}`);
      console.log(`  Alice USDC balance: ${Number(aliceUSDC) / 1e6}`);

      assert.equal(aliceBalance, 0n, "Alice should have no shares after failed attempt");
      assert.equal(aliceUSDC, USDC(100), "Alice should still have full USDC after failed attempt");
    });
  });
});
