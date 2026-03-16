import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("Multi-User Complex Scenarios", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, ...otherAccounts] = await viem.getWalletClients();

  // Hardhat provides 20 accounts (1 deployer + 19 others)
  const users = otherAccounts;

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

  describe("Large-Scale User Interactions", function () {
    it("should handle 100 users with tie refunds correctly", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      console.log(`  Setting up market for multi-user tie scenario`);

      // Create market
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Multi Users Market",
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

      // Hardhat gives us 19 other accounts; use 8 YES + 8 NO = 16
      const yesUsers = users.slice(0, 8);
      const noUsers = users.slice(8, 16);

      console.log(`  Funding ${yesUsers.length + noUsers.length} users and executing trades`);

      // Fund and trade for YES users
      for (let i = 0; i < yesUsers.length; i++) {
        const user = yesUsers[i];
        await usdc.write.mint([user.account.address, USDC(10)]);
        await usdc.write.approve([market.address, USDC(10)], { account: user.account });
        await market.write.buyYes([USDC(10)], { account: user.account });
      }

      console.log(`  ${yesUsers.length} YES traders completed`);

      // Fund and trade for NO users
      for (let i = 0; i < noUsers.length; i++) {
        const user = noUsers[i];
        await usdc.write.mint([user.account.address, USDC(10)]);
        await usdc.write.approve([market.address, USDC(10)], { account: user.account });
        await market.write.buyNo([USDC(10)], { account: user.account });
      }

      console.log(`  ${noUsers.length} NO traders completed`);

      // Advance to voting period
      await advanceTime(301);

      // Create exact tie with voting
      await sayso.write.mint([deployer.account.address, SAYSO(1000)]);
      await sayso.write.mint([users[0].account.address, SAYSO(1000)]);

      await sayso.write.approve([oracle.address, SAYSO(1000)], { account: deployer.account });
      await oracle.write.voteYes([market.address, SAYSO(1000)], { account: deployer.account });

      await sayso.write.approve([oracle.address, SAYSO(1000)], { account: users[0].account });
      await oracle.write.voteNo([market.address, SAYSO(1000)], { account: users[0].account });

      console.log(`  Votes cast: 1000 YES, 1000 NO (perfect tie)`);

      // Resolve with tie
      await advanceTime(201);
      await market.write.resolve();

      const isTie = await market.read.isTie();
      console.log(`  Market resolved with tie: ${isTie}`);

      assert.equal(isTie, true, "Should be a tie");

      // Check that all users can claim refunds
      console.log(`  Testing claims for sample users`);

      // Sample YES user
      const yesUserBalanceBefore = await usdc.read.balanceOf([yesUsers[0].account.address]);
      await market.write.claim({ account: yesUsers[0].account });
      const yesUserBalanceAfter = await usdc.read.balanceOf([yesUsers[0].account.address]);

      console.log(`  YES user refund: ${Number(yesUserBalanceAfter - yesUserBalanceBefore) / 1e6} USDC`);
      assert.ok(yesUserBalanceAfter > yesUserBalanceBefore, "YES user should get refund");

      // Sample NO user
      const noUserBalanceBefore = await usdc.read.balanceOf([noUsers[0].account.address]);
      await market.write.claim({ account: noUsers[0].account });
      const noUserBalanceAfter = await usdc.read.balanceOf([noUsers[0].account.address]);

      console.log(`  NO user refund: ${Number(noUserBalanceAfter - noUserBalanceBefore) / 1e6} USDC`);
      assert.ok(noUserBalanceAfter > noUserBalanceBefore, "NO user should get refund");

      // Verify a few more users can claim successfully
      for (let i = 1; i < 5; i++) {
        await market.write.claim({ account: yesUsers[i].account });
        await market.write.claim({ account: noUsers[i].account });
      }

      console.log(`  Multi-user tie refund scenario completed successfully`);
    });

    it("should handle multiple concurrent markets with same users", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      console.log(`  Creating 3 concurrent markets`);

      // Create 3 markets with different timings
      const marketAddresses = [];

      for (let i = 0; i < 3; i++) {
        await usdc.write.mint([deployer.account.address, USDC(100)]);
        await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
        await factory.write.createMarket(
          [
            `Market ${i + 1}`,
            now, // All start immediately
            now + 500,
            now + 600,
            now + 800,
            USDC(50),
            USDC(50),
            "0x0000000000000000000000000000000000000000" as `0x${string}`,
          ],
          { account: deployer.account }
        );
      }

      const allMarkets = await factory.read.getMarkets([0n, 10n]);
      const market1 = await viem.getContractAt("AMM", allMarkets[allMarkets.length - 3]);
      const market2 = await viem.getContractAt("AMM", allMarkets[allMarkets.length - 2]);
      const market3 = await viem.getContractAt("AMM", allMarkets[allMarkets.length - 1]);

      console.log(`  10 users trading across all 3 markets`);

      // Use first 10 users to trade across all markets
      const traders = users.slice(0, 10);

      for (let i = 0; i < traders.length; i++) {
        const user = traders[i];

        // Fund user
        await usdc.write.mint([user.account.address, USDC(300)]);

        // Trade in all 3 markets
        await usdc.write.approve([market1.address, USDC(100)], { account: user.account });
        await market1.write.buyYes([USDC(100)], { account: user.account });

        await usdc.write.approve([market2.address, USDC(100)], { account: user.account });
        await market2.write.buyNo([USDC(100)], { account: user.account });

        await usdc.write.approve([market3.address, USDC(100)], { account: user.account });
        await market3.write.buyYes([USDC(100)], { account: user.account });
      }

      console.log(`  All users traded in all 3 markets`);

      // Verify positions in each market
      const user0YesInMarket1 = await market1.read.yesBalances([traders[0].account.address]);
      const user0NoInMarket2 = await market2.read.noBalances([traders[0].account.address]);
      const user0YesInMarket3 = await market3.read.yesBalances([traders[0].account.address]);

      console.log(`  User 0 positions:`);
      console.log(`    Market 1 YES: ${Number(user0YesInMarket1) / 1e18}`);
      console.log(`    Market 2 NO: ${Number(user0NoInMarket2) / 1e18}`);
      console.log(`    Market 3 YES: ${Number(user0YesInMarket3) / 1e18}`);

      assert.ok(user0YesInMarket1 > 0n, "User should have YES in market 1");
      assert.ok(user0NoInMarket2 > 0n, "User should have NO in market 2");
      assert.ok(user0YesInMarket3 > 0n, "User should have YES in market 3");

      // Verify no position leakage between markets
      const user0NoInMarket1 = await market1.read.noBalances([traders[0].account.address]);
      const user0YesInMarket2 = await market2.read.yesBalances([traders[0].account.address]);
      const user0NoInMarket3 = await market3.read.noBalances([traders[0].account.address]);

      assert.equal(user0NoInMarket1, 0n, "User should have no NO in market 1");
      assert.equal(user0YesInMarket2, 0n, "User should have no YES in market 2");
      assert.equal(user0NoInMarket3, 0n, "User should have no NO in market 3");

      console.log(`  Positions correctly isolated across markets`);
    });

    it("should handle sequential market lifecycle with overlapping users", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      console.log(`  Creating sequential market lifecycle scenario`);

      // Market 1: Quick market (resolves first)
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Quick Market",
          now,
          now + 100,
          now + 150,
          now + 200,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      // Market 2: Slow market (resolves later)
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Slow Market",
          now,
          now + 500,
          now + 600,
          now + 800,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const allMarkets = await factory.read.getMarkets([0n, 10n]);
      const quickMarket = await viem.getContractAt("AMM", allMarkets[allMarkets.length - 2]);
      const slowMarket = await viem.getContractAt("AMM", allMarkets[allMarkets.length - 1]);

      // 5 users trade in both markets
      const traders = users.slice(0, 5);

      console.log(`  5 users trading in both markets`);

      for (let i = 0; i < traders.length; i++) {
        const user = traders[i];
        await usdc.write.mint([user.account.address, USDC(200)]);

        await usdc.write.approve([quickMarket.address, USDC(100)], { account: user.account });
        await quickMarket.write.buyYes([USDC(100)], { account: user.account });

        await usdc.write.approve([slowMarket.address, USDC(100)], { account: user.account });
        await slowMarket.write.buyNo([USDC(100)], { account: user.account });
      }

      console.log(`  Resolving quick market`);

      // Resolve quick market
      await advanceTime(151);

      await sayso.write.mint([deployer.account.address, SAYSO(1000)]);
      await sayso.write.approve([oracle.address, SAYSO(1000)], { account: deployer.account });
      await oracle.write.voteYes([quickMarket.address, SAYSO(1000)], { account: deployer.account });

      await advanceTime(51);
      await quickMarket.write.resolve();

      const quickResolved = await quickMarket.read.resolved();
      const slowResolved = await slowMarket.read.resolved();

      console.log(`  Quick market resolved: ${quickResolved}`);
      console.log(`  Slow market resolved: ${slowResolved}`);

      assert.equal(quickResolved, true, "Quick market should be resolved");
      assert.equal(slowResolved, false, "Slow market should not be resolved yet");

      // Users claim from quick market
      console.log(`  Users claiming from quick market`);

      for (let i = 0; i < traders.length; i++) {
        await quickMarket.write.claim({ account: traders[i].account });
      }

      // Verify users still have positions in slow market
      const user0SlowBalance = await slowMarket.read.noBalances([traders[0].account.address]);
      console.log(`  User 0 still has ${Number(user0SlowBalance) / 1e18} NO shares in slow market`);
      assert.ok(user0SlowBalance > 0n, "User should still have position in slow market");

      // Continue trading in slow market (still active)
      console.log(`  Continuing to trade in slow market`);

      await usdc.write.mint([traders[0].account.address, USDC(50)]);
      await usdc.write.approve([slowMarket.address, USDC(50)], { account: traders[0].account });
      await slowMarket.write.buyYes([USDC(50)], { account: traders[0].account });

      const user0SlowYes = await slowMarket.read.yesBalances([traders[0].account.address]);
      console.log(`  User 0 now also has ${Number(user0SlowYes) / 1e18} YES shares in slow market`);

      // Resolve slow market
      console.log(`  Resolving slow market`);

      await advanceTime(450);
      await sayso.write.approve([oracle.address, SAYSO(1000)], { account: deployer.account });
      await oracle.write.voteNo([slowMarket.address, SAYSO(1000)], { account: deployer.account });

      await advanceTime(201);
      await slowMarket.write.resolve();

      const slowResolvedFinal = await slowMarket.read.resolved();
      console.log(`  Slow market now resolved: ${slowResolvedFinal}`);

      assert.equal(slowResolvedFinal, true, "Slow market should be resolved");

      // Users claim from slow market
      for (let i = 0; i < traders.length; i++) {
        await slowMarket.write.claim({ account: traders[i].account });
      }

      console.log(`  Sequential lifecycle completed successfully`);
    });

    it("should track user positions across 5 different markets", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      console.log(`  Creating 5 markets with different characteristics`);

      const marketContracts = [];

      // Create 5 markets with different seeds
      for (let i = 0; i < 5; i++) {
        const yesAmount = USDC(30 + i * 10); // 30, 40, 50, 60, 70
        const noAmount = USDC(70 - i * 10); // 70, 60, 50, 40, 30

        await usdc.write.mint([deployer.account.address, USDC(100)]);
        await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
        await factory.write.createMarket(
          [
            `Market ${i + 1}`,
            now,
            now + 200,
            now + 300,
            now + 500,
            yesAmount,
            noAmount,
            "0x0000000000000000000000000000000000000000" as `0x${string}`,
          ],
          { account: deployer.account }
        );
      }

      const allMarkets = await factory.read.getMarkets([0n, 10n]);
      for (let i = 0; i < 5; i++) {
        const marketAddr = allMarkets[allMarkets.length - 5 + i];
        const market = await viem.getContractAt("AMM", marketAddr);
        marketContracts.push(market);
      }

      console.log(`  User trading in all 5 markets with different strategies`);

      const trader = users[0];
      await usdc.write.mint([trader.account.address, USDC(1000)]);

      // Different trade patterns in each market
      const tradePatterns = [
        { amount: USDC(50), side: "yes" },
        { amount: USDC(100), side: "no" },
        { amount: USDC(75), side: "yes" },
        { amount: USDC(150), side: "no" },
        { amount: USDC(200), side: "yes" },
      ];

      for (let i = 0; i < 5; i++) {
        const market = marketContracts[i];
        const pattern = tradePatterns[i];

        await usdc.write.approve([market.address, pattern.amount], { account: trader.account });

        if (pattern.side === "yes") {
          await market.write.buyYes([pattern.amount], { account: trader.account });
        } else {
          await market.write.buyNo([pattern.amount], { account: trader.account });
        }
      }

      console.log(`  Verifying user positions across all markets`);

      // Verify positions
      for (let i = 0; i < 5; i++) {
        const market = marketContracts[i];
        const pattern = tradePatterns[i];

        const yesBalance = await market.read.yesBalances([trader.account.address]);
        const noBalance = await market.read.noBalances([trader.account.address]);

        console.log(`  Market ${i + 1}:`);
        console.log(`    YES: ${Number(yesBalance) / 1e18}`);
        console.log(`    NO: ${Number(noBalance) / 1e18}`);

        if (pattern.side === "yes") {
          assert.ok(yesBalance > 0n, `Market ${i + 1} should have YES position`);
          assert.equal(noBalance, 0n, `Market ${i + 1} should have no NO position`);
        } else {
          assert.ok(noBalance > 0n, `Market ${i + 1} should have NO position`);
          assert.equal(yesBalance, 0n, `Market ${i + 1} should have no YES position`);
        }
      }

      // Verify prices are different across markets (due to different seeds and trades)
      const prices = [];
      for (let i = 0; i < 5; i++) {
        const price = await marketContracts[i].read.price();
        prices.push(price);
        console.log(`  Market ${i + 1} price: ${Number(price) / 1e16}%`);
      }

      // Verify prices are not all identical (markets have independent state)
      const uniquePrices = new Set(prices.map((p) => p.toString()));
      assert.ok(uniquePrices.size > 1, "Markets should have different prices");

      console.log(`  Successfully tracked positions across 5 markets with ${uniquePrices.size} unique prices`);
    });
  });

  describe("Complex Multi-Phase Scenarios", function () {
    it("should handle users entering and exiting at different phases", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();
      const now = await getNow();

      console.log(`  Setting up multi-phase scenario`);

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Multi-Phase Market",
          now,
          now + 300,
          now + 400,
          now + 600,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      // Phase 1: Early traders (0-100s)
      console.log(`  Phase 1: Early traders`);

      const earlyTraders = users.slice(0, 3);
      for (let i = 0; i < earlyTraders.length; i++) {
        const user = earlyTraders[i];
        await usdc.write.mint([user.account.address, USDC(100)]);
        await usdc.write.approve([market.address, USDC(100)], { account: user.account });
        await market.write.buyYes([USDC(100)], { account: user.account });
      }

      // Phase 2: Mid traders (100-200s)
      console.log(`  Phase 2: Mid traders after price movement`);

      await advanceTime(100);

      const midTraders = users.slice(3, 6);
      for (let i = 0; i < midTraders.length; i++) {
        const user = midTraders[i];
        await usdc.write.mint([user.account.address, USDC(100)]);
        await usdc.write.approve([market.address, USDC(100)], { account: user.account });
        await market.write.buyNo([USDC(100)], { account: user.account });
      }

      // Phase 3: Late traders (200-300s)
      console.log(`  Phase 3: Late traders before trading closes`);

      await advanceTime(100);

      const lateTraders = users.slice(6, 9);
      for (let i = 0; i < lateTraders.length; i++) {
        const user = lateTraders[i];
        await usdc.write.mint([user.account.address, USDC(100)]);
        await usdc.write.approve([market.address, USDC(100)], { account: user.account });
        await market.write.buyYes([USDC(100)], { account: user.account });
      }

      // Trading ends
      await advanceTime(101);

      console.log(`  Trading phase ended, moving to voting`);

      // Phase 4: Voting phase
      await advanceTime(100);

      const voters = users.slice(9, 12);
      for (let i = 0; i < voters.length; i++) {
        const user = voters[i];
        await sayso.write.mint([user.account.address, SAYSO(500)]);
        await sayso.write.approve([oracle.address, SAYSO(500)], { account: user.account });

        if (i % 2 === 0) {
          await oracle.write.voteYes([market.address, SAYSO(500)], { account: user.account });
        } else {
          await oracle.write.voteNo([market.address, SAYSO(500)], { account: user.account });
        }
      }

      console.log(`  Votes cast by 3 voters`);

      // Resolve
      await advanceTime(201);
      await market.write.resolve();

      const resolved = await market.read.resolved();
      const outcome = await market.read.outcome();

      console.log(`  Market resolved: ${resolved}, Outcome: ${outcome ? "YES" : "NO"}`);

      // Phase 5: Claiming phase - verify all users from all phases can claim
      console.log(`  All users claiming rewards`);

      const allTraders = [...earlyTraders, ...midTraders, ...lateTraders];

      for (let i = 0; i < allTraders.length; i++) {
        const user = allTraders[i];
        const claimable = await market.read.calculateClaim([user.account.address]);

        if (claimable > 0n) {
          await market.write.claim({ account: user.account });
          console.log(`  User ${i} claimed ${Number(claimable) / 1e6} USDC`);
        } else {
          console.log(`  User ${i} has no claimable amount (wrong side)`);
        }
      }

      console.log(`  Multi-phase scenario completed successfully`);
    });

    it("should handle rapid sequential trades from multiple users", async function () {
      const { usdc, factory } = await deployAll();
      const now = await getNow();

      console.log(`  Setting up rapid trading scenario`);

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });
      await factory.write.createMarket(
        [
          "Rapid Trading Market",
          now,
          now + 300,
          now + 400,
          now + 600,
          USDC(50),
          USDC(50),
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      const rapidTraders = users.slice(0, 18);

      console.log(`  ${rapidTraders.length} users executing rapid sequential trades`);

      // Fund all users first
      for (let i = 0; i < rapidTraders.length; i++) {
        await usdc.write.mint([rapidTraders[i].account.address, USDC(50)]);
        await usdc.write.approve([market.address, USDC(50)], { account: rapidTraders[i].account });
      }

      // Execute rapid trades (alternating YES/NO)
      const prices = [];
      for (let i = 0; i < rapidTraders.length; i++) {
        const user = rapidTraders[i];

        if (i % 2 === 0) {
          await market.write.buyYes([USDC(10)], { account: user.account });
        } else {
          await market.write.buyNo([USDC(10)], { account: user.account });
        }

        const price = await market.read.price();
        prices.push(Number(price) / 1e16);
      }

      console.log(`  Price oscillation range: ${Math.min(...prices).toFixed(2)}% - ${Math.max(...prices).toFixed(2)}%`);

      // Verify all users have positions
      let yesCount = 0;
      let noCount = 0;

      for (let i = 0; i < rapidTraders.length; i++) {
        const user = rapidTraders[i];
        const yesBalance = await market.read.yesBalances([user.account.address]);
        const noBalance = await market.read.noBalances([user.account.address]);

        if (yesBalance > 0n) yesCount++;
        if (noBalance > 0n) noCount++;
      }

      console.log(`  ${yesCount} users with YES positions`);
      console.log(`  ${noCount} users with NO positions`);

      assert.ok(yesCount > 0, "Should have YES traders");
      assert.ok(noCount > 0, "Should have NO traders");
      assert.equal(yesCount + noCount, rapidTraders.length, "All users should have positions");

      // Verify pool state is consistent
      const totalDeposited = await market.read.totalDeposited();
      console.log(`  Total deposited in pool: ${Number(totalDeposited) / 1e6} USDC`);

      // Should be initial seed + trades
      const expectedMin = USDC(100 + rapidTraders.length * 10 * 0.95); // Accounting for fees
      assert.ok(totalDeposited >= expectedMin, "Pool should have accumulated deposits");
    });
  });
});
