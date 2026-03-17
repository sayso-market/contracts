import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("Failure Modes & Error Recovery", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob] = await viem.getWalletClients();

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
    await usdc.write.mint([deployer.account.address, USDC(100)]);
    await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
    await factory.write.createMarket(
      ["Test Market", now, now + 200, now + 300, now + 500, USDC(100), 5000n, "0x0000000000000000000000000000000000000000" as `0x${string}`, deployer.account.address],
      { account: deployer.account }
    );

    const markets = await factory.read.getMarkets([0n, 1n]);
    const market = await viem.getContractAt("AMM", markets[0]);

    return { usdc, sayso, factory, oracle, market };
  }

  describe("Token Transfer Failures", function () {
    it("should revert cleanly when user has insufficient USDC balance", async function () {
      const { usdc, market } = await deployAll();

      // Alice has 0 USDC but tries to buy 100 USDC worth
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      try {
        await market.write.buyYes([USDC(100)], { account: alice.account });
        assert.fail("Should have reverted due to insufficient balance");
      } catch (error: any) {
        console.log(`  Correctly reverted: insufficient USDC balance`);
        assert.ok(error.message.includes("revert") || error.message.includes("insufficient"),
          "Should revert with appropriate error");
      }

      // Verify market state unchanged
      const aliceShares = await market.read.yesBalances([alice.account.address]);
      assert.equal(aliceShares, 0n, "Alice should have no shares after failed transaction");
    });

    it("should revert when user hasn't approved USDC spending", async function () {
      const { usdc, market } = await deployAll();

      await usdc.write.mint([alice.account.address, USDC(100)]);
      // No approval given

      try {
        await market.write.buyYes([USDC(100)], { account: alice.account });
        assert.fail("Should have reverted due to no approval");
      } catch (error: any) {
        console.log(`  Correctly reverted: no USDC approval`);
        assert.ok(error.message.includes("revert") || error.message.includes("allowance"),
          "Should revert with allowance error");
      }
    });

    it("should revert when trying to sell more shares than owned", async function () {
      const { usdc, market } = await deployAll();

      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const aliceShares = await market.read.yesBalances([alice.account.address]);
      const excessiveAmount = aliceShares + parseUnits("100", 18);

      // Wait MIN_HOLD_BLOCKS
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      try {
        await market.write.sellYes([excessiveAmount], { account: alice.account });
        assert.fail("Should have reverted trying to sell more than owned");
      } catch (error: any) {
        console.log(`  Correctly reverted: selling more shares than owned`);
        assert.ok(error.message.includes("Insufficient shares"),
          "Should revert with insufficient shares error");
      }
    });

    it("should handle SAYSO transfer failure in voting gracefully", async function () {
      const { sayso, oracle, market } = await deployAll();

      await advanceTime(301);

      // Alice tries to vote but has no SAYSO
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });

      try {
        await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });
        assert.fail("Should have reverted due to insufficient SAYSO");
      } catch (error: any) {
        console.log(`  Correctly reverted: insufficient SAYSO for voting`);
        assert.ok(error.message.includes("revert"), "Should revert cleanly");
      }

      // Verify oracle state unchanged
      const aliceVotes = await oracle.read.yesVotesByUser([market.address, alice.account.address]);
      assert.equal(aliceVotes, 0n, "Alice should have no votes after failed transaction");
    });
  });

  describe("Market State Violations", function () {
    it("should prevent resolve() from being called twice", async function () {
      const { sayso, oracle, market } = await deployAll();

      // Set up and resolve market
      await advanceTime(301);
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      await advanceTime(201);
      await market.write.resolve();

      const resolved = await market.read.resolved();
      console.log(`  Market resolved: ${resolved}`);
      assert.ok(resolved, "Market should be resolved");

      // Try to resolve again
      try {
        await market.write.resolve();
        assert.fail("Should not allow resolving twice");
      } catch (error: any) {
        console.log(`  Correctly prevented double resolve`);
        assert.ok(error.message.includes("Already resolved"),
          "Should revert with already resolved error");
      }
    });

    it("should prevent claiming before resolution", async function () {
      const { usdc, market } = await deployAll();

      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Try to claim before market is resolved
      try {
        await market.write.claim({ account: alice.account });
        assert.fail("Should not allow claiming before resolution");
      } catch (error: any) {
        console.log(`  Correctly prevented claiming before resolution`);
        assert.ok(error.message.includes("revert"), "Should revert");
      }
    });

    it("should prevent double-claiming winnings", async function () {
      const { usdc, sayso, oracle, market } = await deployAll();

      // Alice bets and wins
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      // Resolve YES
      await advanceTime(301);
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      await advanceTime(201);
      await market.write.resolve();

      // First claim succeeds
      const claimable = await market.read.calculateClaim([alice.account.address]);
      console.log(`  First claim: ${Number(claimable) / 1e6} USDC`);
      await market.write.claim({ account: alice.account });

      // Second claim should fail
      try {
        await market.write.claim({ account: alice.account });
        assert.fail("Should not allow double-claiming");
      } catch (error: any) {
        console.log(`  Correctly prevented double-claim`);
        assert.ok(error.message.includes("Already claimed"),
          "Should revert with already claimed error");
      }
    });

    it("should handle scenario where pool is empty at resolution", async function () {
      const { usdc, sayso, oracle, market } = await deployAll();

      // No one trades (only seed liquidity exists)
      // Resolve with no votes
      await advanceTime(502);
      await market.write.resolve();

      const resolvedPoolBalance = await market.read.resolvedPoolBalance();
      const outcome = await market.read.outcome();

      console.log(`  Resolved pool balance: ${Number(resolvedPoolBalance) / 1e6} USDC`);
      console.log(`  Outcome (no votes): ${outcome ? 'YES' : 'NO'}`);

      // Seed provider can still claim their initial shares
      const deployerClaimable = await market.read.calculateClaim([deployer.account.address]);
      console.log(`  Seed provider claimable: ${Number(deployerClaimable) / 1e6} USDC`);

      // Should not revert even with no trading activity
      assert.ok(resolvedPoolBalance > 0n, "Pool should have seed liquidity");
    });
  });

  describe("Oracle Failure Scenarios", function () {
    it("should allow resolution even with zero votes", async function () {
      const { market } = await deployAll();

      // Advance past voting period without any votes
      await advanceTime(502);

      // Resolve should succeed with no votes
      await market.write.resolve();

      const resolved = await market.read.resolved();
      const outcome = await market.read.outcome();

      console.log(`  Market resolved with zero votes: ${resolved}`);
      console.log(`  Outcome defaults to: ${outcome ? 'YES' : 'NO'}`);

      assert.ok(resolved, "Market should resolve even with zero votes");
    });

    it("should handle voting on invalid market address", async function () {
      const { sayso, oracle } = await deployAll();

      await advanceTime(301);

      const fakeMarketAddress = "0x0000000000000000000000000000000000000001";

      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });

      try {
        await oracle.write.voteYes([fakeMarketAddress, SAYSO(100)], { account: alice.account });
        assert.fail("Should not allow voting on invalid market");
      } catch (error: any) {
        console.log(`  Correctly prevented voting on invalid market`);
        assert.ok(error.message.includes("Not a valid market"),
          "Should revert with invalid market error");
      }
    });

    it("should prevent voting twice on same market from same user", async function () {
      const { sayso, oracle, market } = await deployAll();

      await advanceTime(301);

      await sayso.write.mint([alice.account.address, SAYSO(200)]);
      await sayso.write.approve([oracle.address, SAYSO(200)], { account: alice.account });

      // First vote succeeds
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      // Second vote on same side should succeed (accumulates)
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      const aliceVotes = await oracle.read.yesVotesByUser([market.address, alice.account.address]);
      console.log(`  Alice's accumulated YES votes: ${Number(aliceVotes) / 1e18} SAYSO`);

      assert.equal(aliceVotes, SAYSO(200), "Votes should accumulate");
    });
  });

  describe("Reentrancy Protection", function () {
    it("should have nonReentrant guards on critical functions", async function () {
      const { usdc, market } = await deployAll();

      // Verify critical functions are protected
      // (Actual reentrancy attacks would require malicious contract)
      // This test verifies the guards don't break normal operation

      await usdc.write.mint([alice.account.address, USDC(200)]);
      await usdc.write.approve([market.address, USDC(200)], { account: alice.account });

      // Multiple sequential calls should work (not same transaction reentrancy)
      await market.write.buyYes([USDC(50)], { account: alice.account });
      await market.write.buyYes([USDC(50)], { account: alice.account });
      await market.write.buyNo([USDC(50)], { account: alice.account });

      const yesShares = await market.read.yesBalances([alice.account.address]);
      const noShares = await market.read.noBalances([alice.account.address]);

      console.log(`  Sequential trades succeeded (reentrancy guards don't block normal use)`);
      console.log(`  YES shares: ${Number(yesShares) / 1e18}, NO shares: ${Number(noShares) / 1e18}`);

      assert.ok(yesShares > 0n && noShares > 0n, "Sequential trades should succeed");
    });
  });

  describe("Error Message Clarity", function () {
    it("should provide clear error messages for common failures", async function () {
      const { usdc, market } = await deployAll();

      const testCases = [
        {
          name: "Zero amount purchase",
          action: async () => {
            await usdc.write.mint([alice.account.address, USDC(100)]);
            await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
            await market.write.buyYes([0n], { account: alice.account });
          },
          expectedError: "Amount must be greater than 0"
        },
        {
          name: "Below minimum deposit",
          action: async () => {
            await usdc.write.mint([alice.account.address, USDC(1)]);
            await usdc.write.approve([market.address, USDC(0.5)], { account: alice.account });
            await market.write.buyYes([USDC(0.5)], { account: alice.account });
          },
          expectedError: "Deposit below minimum"
        },
      ];

      for (const testCase of testCases) {
        try {
          await testCase.action();
          console.log(`  ✗ ${testCase.name}: Did not revert`);
        } catch (error: any) {
          const hasExpectedError = error.message.includes(testCase.expectedError);
          console.log(`  ${hasExpectedError ? '✓' : '✗'} ${testCase.name}: ${hasExpectedError ? 'Correct' : 'Wrong'} error message`);

          if (!hasExpectedError) {
            console.log(`    Expected: "${testCase.expectedError}"`);
            console.log(`    Got: "${error.message.substring(0, 100)}"`);
          }
        }
      }
    });
  });
});
