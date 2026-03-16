import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("View Functions and Getters", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, dave, eve] = await viem.getWalletClients();

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

  describe("MarketFactory View Functions", function () {
    it("should return empty array for getActiveMarkets when no markets exist", async function () {
      const { factory } = await deployAll();

      const activeMarkets = await factory.read.getActiveMarkets();

      console.log(`  Active markets count: ${activeMarkets.length}`);

      assert.equal(activeMarkets.length, 0, "Should return empty array when no markets");
    });

    it("should correctly identify active markets in trading period", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      // Create market 1: Active (trading period)
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Active Market",
          now - 10, // Started 10s ago
          now + 200, // Ends in 200s
          now + 300,
          now + 500,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      // Create market 2: Not started yet
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Future Market",
          now + 1000, // Starts in future
          now + 1200,
          now + 1300,
          now + 1500,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      // Create market 3: Active (trading period)
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Another Active Market",
          now - 5,
          now + 150,
          now + 250,
          now + 450,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const activeMarkets = await factory.read.getActiveMarkets();

      console.log(`  Total markets: 3`);
      console.log(`  Active markets: ${activeMarkets.length}`);

      assert.equal(activeMarkets.length, 2, "Should return 2 active markets");
    });

    it("should return correct market status breakdown in getMarketsByStatus", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      // Create market 1: Active (trading)
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Trading Market",
          now - 10,
          now + 200,
          now + 300,
          now + 500,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      // Create market 2: Pending (future)
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Future Market",
          now + 1000,
          now + 1200,
          now + 1300,
          now + 1500,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      // Create market 3: Voting period
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Voting Market",
          now - 500,
          now - 100, // Trading ended
          now - 50, // Voting open
          now + 100, // Voting closes soon
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      // getMarketsByStatus returns 3 arrays: trading, resolution, resolved
      // "not started" markets are not included in any category
      const [
        tradingMarkets,
        votingMarkets,
        resolvedMarkets,
      ] = await factory.read.getMarketsByStatus();

      console.log(`  Trading: ${tradingMarkets.length}`);
      console.log(`  Voting: ${votingMarkets.length}`);
      console.log(`  Resolved: ${resolvedMarkets.length}`);

      assert.equal(tradingMarkets.length, 1, "Should have 1 trading market");
      assert.equal(votingMarkets.length, 1, "Should have 1 voting market");
      assert.equal(resolvedMarkets.length, 0, "Should have 0 resolved markets");
    });

    it("should handle empty markets array in getMarketsByStatus", async function () {
      const { factory } = await deployAll();

      // getMarketsByStatus returns 3 arrays: trading, resolution, resolved
      const [trading, voting, resolved] = await factory.read.getMarketsByStatus();

      console.log(`  All categories should be empty`);
      console.log(`  Trading: ${trading.length}`);
      console.log(`  Voting: ${voting.length}`);
      console.log(`  Resolved: ${resolved.length}`);

      assert.equal(trading.length, 0, "Should be empty");
      assert.equal(voting.length, 0, "Should be empty");
      assert.equal(resolved.length, 0, "Should be empty");
    });
  });

  describe("ResolutionOracle View Functions", function () {
    it("should return empty array for getVotingUsers when no votes", async function () {
      const { usdc, factory, oracle } = await deployAll();
      const now = await getNow();

      // Create market
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      const votingUsers = await oracle.read.getVotingUsers([market]);

      console.log(`  Voting users count: ${votingUsers.length}`);

      assert.equal(votingUsers.length, 0, "Should return empty array when no voters");
    });

    it("should return correct voting users after votes are cast", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      // Create market
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      // Advance to voting period
      await advanceTime(301);

      // Fund voters and cast votes
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.mint([bob.account.address, SAYSO(200)]);
      await sayso.write.mint([charlie.account.address, SAYSO(150)]);

      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
      await oracle.write.voteYes([market, SAYSO(100)], { account: alice.account });

      await sayso.write.approve([oracle.address, SAYSO(200)], { account: bob.account });
      await oracle.write.voteNo([market, SAYSO(200)], { account: bob.account });

      await sayso.write.approve([oracle.address, SAYSO(150)], { account: charlie.account });
      await oracle.write.voteYes([market, SAYSO(150)], { account: charlie.account });

      const votingUsers = await oracle.read.getVotingUsers([market]);
      const userCount = await oracle.read.getVotingUserCount([market]);

      console.log(`  Voting users: ${votingUsers.length}`);
      console.log(`  User count: ${userCount}`);

      assert.equal(votingUsers.length, 3, "Should have 3 voting users");
      assert.equal(userCount, 3n, "User count should match");

      // Verify addresses
      const addresses = votingUsers.map((addr: string) => addr.toLowerCase());
      assert.ok(addresses.includes(alice.account.address.toLowerCase()), "Should include Alice");
      assert.ok(addresses.includes(bob.account.address.toLowerCase()), "Should include Bob");
      assert.ok(addresses.includes(charlie.account.address.toLowerCase()), "Should include Charlie");
    });

    it("should return correct YES percentage", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      await advanceTime(301);

      // Cast votes: 300 YES, 700 NO (30% YES)
      await sayso.write.mint([alice.account.address, SAYSO(300)]);
      await sayso.write.mint([bob.account.address, SAYSO(700)]);

      await sayso.write.approve([oracle.address, SAYSO(300)], { account: alice.account });
      await oracle.write.voteYes([market, SAYSO(300)], { account: alice.account });

      await sayso.write.approve([oracle.address, SAYSO(700)], { account: bob.account });
      await oracle.write.voteNo([market, SAYSO(700)], { account: bob.account });

      const yesPercentage = await oracle.read.getYesPercentage([market]);

      console.log(`  YES votes: 300 SAYSO`);
      console.log(`  NO votes: 700 SAYSO`);
      console.log(`  YES percentage: ${Number(yesPercentage) / 1e16}%`);

      // 300 / 1000 = 0.30 = 30% = 0.30 * 1e18
      assert.equal(yesPercentage, 300000000000000000n, "Should be 30%");
    });

    it("should return zero percentage when no votes", async function () {
      const { usdc, factory, oracle } = await deployAll();
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      const yesPercentage = await oracle.read.getYesPercentage([market]);

      console.log(`  YES percentage (no votes): ${Number(yesPercentage) / 1e16}%`);

      // Oracle returns 50% when there are no votes (equal probability)
      assert.equal(yesPercentage, 500000000000000000n, "Should be 50% when no votes");
    });

    it("should return correct outcome from oracle.getOutcome", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      await advanceTime(301);

      // Vote YES with more votes
      await sayso.write.mint([alice.account.address, SAYSO(600)]);
      await sayso.write.mint([bob.account.address, SAYSO(400)]);

      await sayso.write.approve([oracle.address, SAYSO(600)], { account: alice.account });
      await oracle.write.voteYes([market, SAYSO(600)], { account: alice.account });

      await sayso.write.approve([oracle.address, SAYSO(400)], { account: bob.account });
      await oracle.write.voteNo([market, SAYSO(400)], { account: bob.account });

      const [yesWins, hasVotes] = await oracle.read.getOutcome([market]);

      console.log(`  YES wins: ${yesWins}`);
      console.log(`  Has votes: ${hasVotes}`);

      assert.equal(yesWins, true, "YES should win with 60% votes");
      assert.equal(hasVotes, true, "Should have votes");
    });

    it("should return hasVotes=false when no votes cast", async function () {
      const { usdc, factory, oracle } = await deployAll();
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      const [yesWins, hasVotes] = await oracle.read.getOutcome([market]);

      console.log(`  YES wins: ${yesWins}`);
      console.log(`  Has votes: ${hasVotes}`);

      assert.equal(hasVotes, false, "Should have no votes");
    });

    it("should return complete voting info from getPoolVotingInfo", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = markets[0];

      await advanceTime(301);

      // Cast votes
      await sayso.write.mint([alice.account.address, SAYSO(400)]);
      await sayso.write.mint([bob.account.address, SAYSO(600)]);

      await sayso.write.approve([oracle.address, SAYSO(400)], { account: alice.account });
      await oracle.write.voteYes([market, SAYSO(400)], { account: alice.account });

      await sayso.write.approve([oracle.address, SAYSO(600)], { account: bob.account });
      await oracle.write.voteNo([market, SAYSO(600)], { account: bob.account });

      // getPoolVotingInfo returns (totalYes, totalNo, voterCount, yesWinning)
      const [
        yesVotes,
        noVotes,
        voterCount,
        yesWinning,
      ] = await oracle.read.getPoolVotingInfo([market]);

      console.log(`  YES votes: ${Number(yesVotes) / 1e18} SAYSO`);
      console.log(`  NO votes: ${Number(noVotes) / 1e18} SAYSO`);
      console.log(`  Voter count: ${voterCount}`);
      console.log(`  YES winning: ${yesWinning}`);

      assert.equal(yesVotes, SAYSO(400), "YES votes should be 400");
      assert.equal(noVotes, SAYSO(600), "NO votes should be 600");
      assert.equal(voterCount, 2n, "Should have 2 voters");
      assert.equal(yesWinning, false, "NO should be winning (600 > 400)");
    });
  });

  describe("AMM View Functions", function () {
    it("should return correct market info from getMarketInfo", async function () {
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
          USDC(60),
          USDC(40),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // getMarketInfo returns (name, price, totalYes, totalNo, qYes, qNo)
      const [
        marketName,
        currentPrice,
        totalYesShares,
        totalNoShares,
        outstandingYes,
        outstandingNo,
      ] = await market.read.getMarketInfo();

      console.log(`  Market name: ${marketName}`);
      console.log(`  Current price: ${Number(currentPrice) / 1e16}%`);
      console.log(`  totalYes: ${Number(totalYesShares) / 1e18}`);
      console.log(`  totalNo: ${Number(totalNoShares) / 1e18}`);
      console.log(`  qYes: ${Number(outstandingYes) / 1e18}`);
      console.log(`  qNo: ${Number(outstandingNo) / 1e18}`);

      assert.equal(marketName, "Test Market", "Market name should match");
      assert.ok(outstandingYes > 0n, "qYes should be positive");
      assert.ok(outstandingNo > 0n, "qNo should be positive");
      assert.ok(totalYesShares > 0n, "totalYes should be positive");
      assert.ok(totalNoShares > 0n, "totalNo should be positive");
    });

    it("should return correct timing from getMarketTiming", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      const effectiveFrom = now;
      const effectiveTo = now + 200;
      const resolutionOpen = now + 300;
      const resolutionClose = now + 500;

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Test Market",
          effectiveFrom,
          effectiveTo,
          resolutionOpen,
          resolutionClose,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      const [from, to, resOpen, resClose] = await market.read.getMarketTiming();

      console.log(`  Effective from: ${from}`);
      console.log(`  Effective to: ${to}`);
      console.log(`  Resolution open: ${resOpen}`);
      console.log(`  Resolution close: ${resClose}`);

      assert.equal(Number(from), effectiveFrom, "effectiveFrom should match");
      assert.equal(Number(to), effectiveTo, "effectiveTo should match");
      assert.equal(Number(resOpen), resolutionOpen, "resolutionOpen should match");
      assert.equal(Number(resClose), resolutionClose, "resolutionClose should match");
    });

    it("should correctly determine canUserSell for user who just bought", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Fund Alice and buy shares
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const canSellImmediately = await market.read.canUserSell([alice.account.address]);

      console.log(`  Can sell immediately: ${canSellImmediately}`);

      assert.equal(canSellImmediately, false, "Should not be able to sell immediately");

      // Wait MIN_HOLD_BLOCKS
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      const canSellAfterWait = await market.read.canUserSell([alice.account.address]);

      console.log(`  Can sell after wait: ${canSellAfterWait}`);

      assert.equal(canSellAfterWait, true, "Should be able to sell after MIN_HOLD_BLOCKS");
    });

    it("should return true for canUserSell when user never bought", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Check user who never bought anything
      const canSell = await market.read.canUserSell([bob.account.address]);

      console.log(`  Can sell (never bought): ${canSell}`);

      assert.equal(canSell, true, "Should return true for users who never bought");
    });

    it("should handle price() edge case with extreme imbalance", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Create extreme imbalance
      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await usdc.write.approve([market.address, USDC(1000)], { account: alice.account });
      await market.write.buyYes([USDC(1000)], { account: alice.account });

      const price = await market.read.price();

      console.log(`  Price after extreme YES buy: ${Number(price) / 1e16}%`);

      // Price should remain in valid range
      assert.ok(price >= 0n, "Price should be >= 0%");
      assert.ok(price <= 1e18, "Price should be <= 100%");
    });

    it("should return correct outcome from AMM.getOutcome", async function () {
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
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Before resolution
      const [yesWinsBefore, isResolvedBefore] = await market.read.getOutcome();

      console.log(`  Before resolution - YES wins: ${yesWinsBefore}, Is resolved: ${isResolvedBefore}`);

      assert.equal(isResolvedBefore, false, "Should not be resolved yet");

      // Advance to voting and cast votes
      await advanceTime(301);

      await sayso.write.mint([alice.account.address, SAYSO(700)]);
      await sayso.write.mint([bob.account.address, SAYSO(300)]);

      await sayso.write.approve([oracle.address, SAYSO(700)], { account: alice.account });
      await oracle.write.voteYes([market.address, SAYSO(700)], { account: alice.account });

      await sayso.write.approve([oracle.address, SAYSO(300)], { account: bob.account });
      await oracle.write.voteNo([market.address, SAYSO(300)], { account: bob.account });

      // Resolve
      await advanceTime(201);
      await market.write.resolve();

      const [yesWinsAfter, isResolvedAfter] = await market.read.getOutcome();

      console.log(`  After resolution - YES wins: ${yesWinsAfter}, Is resolved: ${isResolvedAfter}`);

      assert.equal(isResolvedAfter, true, "Should be resolved");
      assert.equal(yesWinsAfter, true, "YES should win with 70% votes");
    });
  });
});
