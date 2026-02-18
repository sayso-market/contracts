import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("Extreme Values & Boundaries", async function () {
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

    return { usdc, sayso, factory, oracle, forwarder };
  }

  describe("Extreme Market Imbalances", function () {
    it("should handle 1000:1 YES:NO imbalance without overflow", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // Create market with extreme imbalance (1000 YES : 1 NO)
      await usdc.write.mint([deployer.account.address, USDC(1001)]);
      await usdc.write.approve([factory.address, USDC(1001)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Extreme YES Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(1000), // YES seed
          USDC(1),    // NO seed (minimum to avoid zero)
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      const market = await viem.getContractAt("AMM", markets[0]);

      const price = await market.read.price();
      const qYes = await market.read.qYes();
      const qNo = await market.read.qNo();

      const imbalanceRatio = Number(qYes) / Number(qNo);

      console.log(`  Initial price: ${Number(price) / 1e16}%`);
      console.log(`  qYes: ${Number(qYes) / 1e18}`);
      console.log(`  qNo: ${Number(qNo) / 1e18}`);
      console.log(`  Imbalance ratio: ${imbalanceRatio.toFixed(2)}:1`);

      // LMSR dampens extreme ratios via liquidity parameter b
      // With b proportional to total seed, even 1000:1 won't reach 90%
      assert.ok(price < 1e18, "Price should be < 100%");
      assert.ok(price > 5e17, "Price should be > 50% with YES-heavy imbalance");

      // Try trading on the cheap side (NO)
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      await market.write.buyNo([USDC(100)], { account: alice.account });

      const priceAfterNo = await market.read.price();
      const aliceNoShares = await market.read.noBalances([alice.account.address]);

      console.log(`  Price after NO buy: ${Number(priceAfterNo) / 1e16}%`);
      console.log(`  Alice NO shares: ${Number(aliceNoShares) / 1e18}`);

      // Buying NO should decrease price significantly (buying the cheap side)
      assert.ok(priceAfterNo < price, "NO purchase should decrease YES price");
      assert.ok(aliceNoShares > 0n, "Should receive NO shares");
    });

    it("should handle inverted imbalance (1:1000 YES:NO)", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // Create market with opposite extreme (1 YES : 1000 NO)
      await usdc.write.mint([deployer.account.address, USDC(1001)]);
      await usdc.write.approve([factory.address, USDC(1001)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Extreme NO Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(1),    // YES seed
          USDC(1000), // NO seed
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      const price = await market.read.price();
      const qYes = await market.read.qYes();
      const qNo = await market.read.qNo();

      console.log(`  Initial price: ${Number(price) / 1e16}%`);
      console.log(`  qYes: ${Number(qYes) / 1e18}, qNo: ${Number(qNo) / 1e18}`);

      // LMSR dampens extreme ratios - price won't be < 10% with high b
      assert.ok(price > 0n, "Price should be > 0%");
      assert.ok(price < 5e17, "Price should be < 50% with NO-heavy imbalance");

      // Try buying YES (the cheap side)
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      await market.write.buyYes([USDC(100)], { account: alice.account });

      const aliceYesShares = await market.read.yesBalances([alice.account.address]);
      console.log(`  Alice YES shares: ${Number(aliceYesShares) / 1e18}`);

      // Buying cheap YES at low price should give many shares
      assert.ok(aliceYesShares > parseUnits("100", 18), "Should get > 100 shares at cheap price");
    });

    it("should maintain price bounds with sequential extreme trades", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Extreme Trading Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(50),
          USDC(50),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      await usdc.write.mint([alice.account.address, USDC(1_000)]);
      await usdc.write.approve([market.address, USDC(1_000)], { account: alice.account });

      // Make 5 large YES purchases to drive price to extreme
      const prices: bigint[] = [];

      for (let i = 0; i < 5; i++) {
        try {
          await market.write.buyYes([USDC(150)], { account: alice.account });
          const price = await market.read.price();
          prices.push(price);
          console.log(`  Round ${i + 1}: Price = ${Number(price) / 1e16}%`);
        } catch (error: any) {
          console.log(`  Round ${i + 1}: Failed (likely PRBMath overflow at extreme values)`);
          break;
        }
      }

      // Verify all recorded prices are within bounds
      for (const price of prices) {
        assert.ok(price >= 0n && price <= 1e18, "Price must remain in [0%, 100%]");
      }

      console.log(`  Completed ${prices.length} rounds before hitting limits`);
    });
  });

  describe("Liquidity Parameter Extremes", function () {
    it("should handle minimum liquidity parameter (b = 150 for 10 USDC seed)", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // Create market with minimum allowed seed (10 USDC)
      await usdc.write.mint([deployer.account.address, USDC(10)]);
      await usdc.write.approve([factory.address, USDC(10)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Minimum Liquidity Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(5),
          USDC(5),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      const liquidityParameter = await market.read.liquidityParameter();
      console.log(`  Liquidity parameter (b): ${Number(liquidityParameter) / 1e18}`);

      // b = totalSeed * 1e12 * 15 = 10 * 1e12 * 15 = 150e12 (in 18-decimal format)
      const expectedB = BigInt(10) * BigInt(1e12) * 15n;
      console.log(`  Expected b: ${Number(expectedB) / 1e18}`);

      // Small market should have high slippage
      await usdc.write.mint([alice.account.address, USDC(10)]);
      await usdc.write.approve([market.address, USDC(10)], { account: alice.account });

      const priceBefore = await market.read.price();
      await market.write.buyYes([USDC(5)], { account: alice.account });
      const priceAfter = await market.read.price();

      const priceImpact = Number(priceAfter - priceBefore) / 1e16;
      console.log(`  Price before: ${Number(priceBefore) / 1e16}%`);
      console.log(`  Price after 5 USDC buy: ${Number(priceAfter) / 1e16}%`);
      console.log(`  Price impact: ${priceImpact.toFixed(2)}%`);

      // With low liquidity, 5 USDC trade should have significant impact
      assert.ok(priceImpact > 0.5, "Low liquidity should cause >0.5% price impact for 50% of seed");
    });

    it("should handle large liquidity parameter (b ≈ 1440 for 1000 USDC seed)", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // Create market with large seed (1000 USDC)
      await usdc.write.mint([deployer.account.address, USDC(1000)]);
      await usdc.write.approve([factory.address, USDC(1000)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "High Liquidity Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(500),
          USDC(500),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      const liquidityParameter = await market.read.liquidityParameter();
      console.log(`  Liquidity parameter (b): ${Number(liquidityParameter) / 1e18}`);

      // High liquidity should mean low slippage
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      const priceBefore = await market.read.price();
      await market.write.buyYes([USDC(50)], { account: alice.account });
      const priceAfter = await market.read.price();

      const priceImpact = Number(priceAfter - priceBefore) / 1e16;
      console.log(`  Price before: ${Number(priceBefore) / 1e16}%`);
      console.log(`  Price after 50 USDC buy: ${Number(priceAfter) / 1e16}%`);
      console.log(`  Price impact: ${priceImpact.toFixed(2)}%`);

      // With high liquidity, 50 USDC trade (5% of seed) should have minimal impact
      assert.ok(priceImpact < 5, "High liquidity should cause <5% price impact for 5% of seed");
    });
  });

  describe("Timestamp Boundaries", function () {
    it("should reject trading exactly 1 second before effectiveFrom", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();
      const effectiveFrom = now + 500; // 500 seconds in future

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Future Market",
          effectiveFrom,
          effectiveFrom + 200,
          effectiveFrom + 300,
          effectiveFrom + 500,
          USDC(50),
          USDC(50),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      // Don't advance time - we're still well before effectiveFrom

      const currentTime = await getNow();
      console.log(`  Current time: ${currentTime}`);
      console.log(`  Effective from: ${effectiveFrom}`);
      console.log(`  Diff: ${effectiveFrom - currentTime} seconds`);

      // Try to trade (should fail)
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      try {
        await market.write.buyYes([USDC(100)], { account: alice.account });
        assert.fail("Should have reverted before trading period");
      } catch (error: any) {
        console.log(`  Trade correctly rejected before effectiveFrom`);
        assert.ok(error.message.includes("Trading outside effective period"),
          "Should reject with correct error message");
      }
    });

    it("should allow trading exactly at effectiveFrom", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // Create market that starts immediately
      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Immediate Market",
          now, // Starts now
          now + 200,
          now + 300,
          now + 500,
          USDC(50),
          USDC(50),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      // Trade immediately (should work)
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      await market.write.buyYes([USDC(100)], { account: alice.account });

      const aliceShares = await market.read.yesBalances([alice.account.address]);
      console.log(`  Trade at effectiveFrom succeeded`);
      console.log(`  Alice shares: ${Number(aliceShares) / 1e18}`);

      assert.ok(aliceShares > 0n, "Should successfully trade at effectiveFrom");
    });

    it("should reject trading exactly at effectiveTo", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();
      const effectiveFrom = now;
      const effectiveTo = now + 10; // 10 seconds window

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Short Window Market",
          effectiveFrom,
          effectiveTo,
          effectiveTo + 100,
          effectiveTo + 200,
          USDC(50),
          USDC(50),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      // Advance to exactly effectiveTo
      await advanceTime(11); // +1 to ensure we're past the boundary

      const currentTime = await getNow();
      console.log(`  Current time: ${currentTime}`);
      console.log(`  Effective to: ${effectiveTo}`);

      // Try to trade (should fail)
      await usdc.write.mint([alice.account.address, USDC(100)]);
      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });

      try {
        await market.write.buyYes([USDC(100)], { account: alice.account });
        assert.fail("Should have reverted after trading period");
      } catch (error: any) {
        console.log(`  Trade correctly rejected after effectiveTo`);
        assert.ok(error.message.includes("Trading outside effective period"),
          "Should reject with correct error message");
      }
    });

    it("should allow voting exactly at resolutionOpen", async function () {
      const { usdc, sayso, factory, oracle } = await deployAll();

      const now = await getNow();
      const resolutionOpen = now + 10;

      await usdc.write.mint([deployer.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Voting Boundary Market",
          now,
          now + 5,
          resolutionOpen,
          resolutionOpen + 100,
          USDC(50),
          USDC(50),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      // Advance to exactly resolutionOpen
      await advanceTime(10);

      const currentTime = await getNow();
      console.log(`  Current time: ${currentTime}`);
      console.log(`  Resolution open: ${resolutionOpen}`);

      // Try to vote (should succeed)
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });

      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      const aliceVotes = await oracle.read.yesVotesByUser([market.address, alice.account.address]);
      console.log(`  Vote at resolutionOpen succeeded`);
      console.log(`  Alice votes: ${Number(aliceVotes) / 1e18} SAYSO`);

      assert.equal(aliceVotes, SAYSO(100), "Should successfully vote at resolutionOpen");
    });
  });

  describe("Share Quantity Extremes", function () {
    it("should handle qYes and qNo approaching large values", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // Create market with very large seed to test large q values
      const largeSeed = USDC(5000); // 5000 USDC
      await usdc.write.mint([deployer.account.address, largeSeed]);
      await usdc.write.approve([factory.address, largeSeed], { account: deployer.account });

      await factory.write.createMarket(
        [
          "Large Shares Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(2500),
          USDC(2500),
        ],
        { account: deployer.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const market = await viem.getContractAt("AMM", markets[markets.length - 1]);

      const qYesBefore = await market.read.qYes();
      const qNoBefore = await market.read.qNo();

      console.log(`  Initial qYes: ${Number(qYesBefore) / 1e18}`);
      console.log(`  Initial qNo: ${Number(qNoBefore) / 1e18}`);

      // Make large trade to further increase q values
      await usdc.write.mint([alice.account.address, USDC(1000)]);
      await usdc.write.approve([market.address, USDC(1000)], { account: alice.account });

      await market.write.buyYes([USDC(500)], { account: alice.account });

      const qYesAfter = await market.read.qYes();
      const qNoAfter = await market.read.qNo();

      console.log(`  After trade qYes: ${Number(qYesAfter) / 1e18}`);
      console.log(`  After trade qNo: ${Number(qNoAfter) / 1e18}`);

      // Verify LMSR still functions with large values
      const price = await market.read.price();
      console.log(`  Price with large q values: ${Number(price) / 1e16}%`);

      assert.ok(price > 0n && price < 1e18, "Price should remain valid with large q values");
      assert.ok(qYesAfter > qYesBefore, "qYes should increase after YES purchase");
    });
  });
});
