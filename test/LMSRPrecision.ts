/**
 * LMSR Precision Tests
 *
 * Validates that on-chain LMSR prices match the mathematical formula:
 *   price_yes = e^(qYes/b) / (e^(qYes/b) + e^(qNo/b))
 *
 * Tests use JavaScript Math to compute expected values and compare to
 * on-chain results with tight tolerances (±0.5%).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const e18 = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";
const FEE_BPS = 50n; // 0.5%
const BPS = 10000n;

/** Compute expected LMSR price using JS math (returns 0..1) */
function expectedPrice(qYes: number, qNo: number, b: number): number {
  const expYes = Math.exp(qYes / b);
  const expNo = Math.exp(qNo / b);
  return expYes / (expYes + expNo);
}

/** Convert an on-chain 18-decimal price to a JS number (0..1) */
function priceToFloat(price: bigint): number {
  return Number(price) / 1e18;
}

/** Convert an on-chain 18-decimal value to a JS number in "ether" units */
function toFloat18(val: bigint): number {
  return Number(val) / 1e18;
}

/** Assert a value is within ±tolerance of expected */
function assertClose(actual: number, expected: number, tolerancePct: number, label: string) {
  const diff = Math.abs(actual - expected);
  const tolerance = Math.abs(expected) * tolerancePct / 100;
  assert.ok(
    diff <= tolerance || diff < 0.001, // absolute floor for values near zero
    `${label}: expected ${(expected * 100).toFixed(2)}%, got ${(actual * 100).toFixed(2)}% (diff ${(diff * 100).toFixed(4)}%, tolerance ±${tolerancePct}%)`
  );
}

describe("LMSR Precision", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [alice, bob] = await viem.getWalletClients();

  // Deploy infrastructure
  const usdc = await viem.deployContract("MockUSDC");
  const sayso = await viem.deployContract("SaySoToken");
  const forwarder = await viem.deployContract("SaySoForwarder");
  const oracle = await viem.deployContract("ResolutionOracle", [
    sayso.address, forwarder.address,
    "0x0000000000000000000000000000000000000000",
  ]);
  const factory = await viem.deployContract("MarketFactory", [
    usdc.address, oracle.address, forwarder.address, FEE_COLLECTOR,
  ]);
  await oracle.write.setFactory([factory.address]);

  // Also deploy TestLMSR for direct library calls
  const lmsr = await viem.deployContract("TestLMSR");

  // Fund accounts
  await usdc.write.mint([alice.account.address, USDC(1_000_000)]);
  await usdc.write.mint([bob.account.address, USDC(1_000_000)]);

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  async function createMarket(yesUsdc: number, noUsdc: number): Promise<any> {
    const now = await getNow();
    const total = USDC(yesUsdc + noUsdc);
    await usdc.write.approve([factory.address, total], { account: alice.account });
    await factory.write.createMarket([
      `Test ${yesUsdc}/${noUsdc}`,
      now, now + 3600, now + 7200, now + 10800,
      USDC(yesUsdc), USDC(noUsdc),
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
    ], { account: alice.account });
    const markets = await factory.read.getAllMarkets();
    return viem.getContractAt("AMM", markets[markets.length - 1]);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 1. LMSR Library: Exact price formula verification
  // ═══════════════════════════════════════════════════════════════════

  describe("LMSR formula verification (library)", function () {
    const testCases = [
      // { qYes, qNo, b, label }
      { qYes: 100, qNo: 100, b: 144, label: "balanced 100/100, b=144" },
      { qYes: 50, qNo: 50, b: 14.4, label: "balanced small pool (b=14.4)" },
      { qYes: 75, qNo: 25, b: 144, label: "75/25 split" },
      { qYes: 25, qNo: 75, b: 144, label: "25/75 split" },
      { qYes: 90, qNo: 10, b: 144, label: "90/10 split" },
      { qYes: 10, qNo: 90, b: 144, label: "10/90 split" },
      { qYes: 60, qNo: 40, b: 144, label: "60/40 split" },
      { qYes: 5, qNo: 5, b: 14.4, label: "$10 seed balanced (b=14.4)" },
      { qYes: 6, qNo: 4, b: 14.4, label: "$10 seed 60/40 (b=14.4)" },
      { qYes: 2.5, qNo: 7.5, b: 14.4, label: "$10 seed 25/75 (b=14.4)" },
      { qYes: 500, qNo: 500, b: 1440, label: "$1000 seed balanced (b=1440)" },
      { qYes: 600, qNo: 400, b: 1440, label: "$1000 seed 60/40 (b=1440)" },
    ];

    for (const tc of testCases) {
      it(`should match formula for ${tc.label}`, async function () {
        const expected = expectedPrice(tc.qYes, tc.qNo, tc.b);
        const onChain = await lmsr.read.priceYes([
          e18(tc.qYes), e18(tc.qNo), e18(tc.b),
        ]);
        const actual = priceToFloat(onChain);

        console.log(`  ${tc.label}: expected=${(expected * 100).toFixed(3)}%, on-chain=${(actual * 100).toFixed(3)}%`);

        assertClose(actual, expected, 0.5, tc.label);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Factory b-parameter calculation
  // ═══════════════════════════════════════════════════════════════════

  describe("liquidity parameter (b) calculation", function () {
    it("should set b = totalSeed * 1e12 * 15 for $10 seed", async function () {
      const market = await createMarket(5, 5);
      const b = await market.read.liquidityParameter();
      // b = 10e6 * 1e12 * 15 = 150e18
      const expected = 150_000_000_000_000_000_000n; // 150e18
      assert.equal(b, expected, `b should be 150e18, got ${b}`);
    });

    it("should set b = totalSeed * 1e12 * 15 for $100 seed", async function () {
      const market = await createMarket(50, 50);
      const b = await market.read.liquidityParameter();
      const expected = 1_500_000_000_000_000_000_000n; // 1500e18
      assert.equal(b, expected, `b should be 1500e18, got ${b}`);
    });

    it("should set b = totalSeed * 1e12 * 15 for $1000 seed", async function () {
      const market = await createMarket(500, 500);
      const b = await market.read.liquidityParameter();
      const expected = 15_000_000_000_000_000_000_000n; // 15000e18
      assert.equal(b, expected, `b should be 15000e18, got ${b}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Initial seed prices match formula
  // ═══════════════════════════════════════════════════════════════════

  describe("initial seed prices", function () {
    const seedCases = [
      { yes: 5, no: 5, label: "$10 balanced" },
      { yes: 6, no: 4, label: "$10 at 60/40" },
      { yes: 7.5, no: 2.5, label: "$10 at 75/25" },
      { yes: 2.5, no: 7.5, label: "$10 at 25/75" },
      { yes: 50, no: 50, label: "$100 balanced" },
      { yes: 75, no: 25, label: "$100 at 75/25" },
      { yes: 500, no: 500, label: "$1000 balanced" },
      { yes: 9, no: 1, label: "$10 at 90/10" },
    ];

    for (const sc of seedCases) {
      it(`should have correct price for ${sc.label} seed`, async function () {
        const market = await createMarket(sc.yes, sc.no);
        const price = await market.read.price();
        const actual = priceToFloat(price);

        const totalSeed = sc.yes + sc.no;
        const b = totalSeed; // amplifier cancels: qYes*amp / (b*amp) = seedYes/totalSeed
        const expected = expectedPrice(sc.yes, sc.no, b);

        console.log(`  ${sc.label}: expected=${(expected * 100).toFixed(2)}%, actual=${(actual * 100).toFixed(2)}%`);

        assertClose(actual, expected, 0.5, sc.label);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. Price impact: bet size relative to seed
  // ═══════════════════════════════════════════════════════════════════

  describe("price impact vs bet-to-seed ratio", function () {
    it("$5 bet on $10 pool: moderate impact", async function () {
      const market = await createMarket(5, 5);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const priceBefore = priceToFloat(await market.read.price());
      await market.write.buyYes([USDC(5)], { account: bob.account });
      const priceAfter = priceToFloat(await market.read.price());
      const impact = (priceAfter - priceBefore) * 100;

      console.log(`  $5 on $10: ${priceBefore.toFixed(3)} → ${priceAfter.toFixed(3)} (${impact.toFixed(1)}pp impact)`);

      // $5 is 0.033x b — with high liquidity, price barely moves
      assert.ok(priceAfter > 0.505, `Price should be above 50.5%, got ${(priceAfter * 100).toFixed(1)}%`);
      assert.ok(priceAfter < 0.55, `Price should be below 55%, got ${(priceAfter * 100).toFixed(1)}%`);
    });

    it("$50 bet on $10 pool: moderate impact (0.33x b)", async function () {
      const market = await createMarket(5, 5);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      await market.write.buyYes([USDC(50)], { account: bob.account });
      const priceAfter = priceToFloat(await market.read.price());

      console.log(`  $50 on $10: price → ${(priceAfter * 100).toFixed(1)}%`);

      // $50 is 0.33x b=150 — moderate impact, not extreme
      assert.ok(priceAfter > 0.60, `Price should be >60%, got ${(priceAfter * 100).toFixed(1)}%`);
    });

    it("$50 bet on $100 pool: small impact (0.033x b)", async function () {
      const market = await createMarket(50, 50);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const priceBefore = priceToFloat(await market.read.price());
      await market.write.buyYes([USDC(50)], { account: bob.account });
      const priceAfter = priceToFloat(await market.read.price());
      const impact = (priceAfter - priceBefore) * 100;

      console.log(`  $50 on $100: ${priceBefore.toFixed(3)} → ${priceAfter.toFixed(3)} (${impact.toFixed(1)}pp impact)`);

      // Same absolute bet, 10x larger pool with b=1500 — small impact
      assert.ok(priceAfter > 0.505, `Price should be above 50.5%`);
      assert.ok(priceAfter < 0.55, `Price should be below 55%`);
    });

    it("$50 bet on $1000 pool: minimal impact (0.035x b)", async function () {
      const market = await createMarket(500, 500);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const priceBefore = priceToFloat(await market.read.price());
      await market.write.buyYes([USDC(50)], { account: bob.account });
      const priceAfter = priceToFloat(await market.read.price());
      const impact = (priceAfter - priceBefore) * 100;

      console.log(`  $50 on $1000: ${priceBefore.toFixed(3)} → ${priceAfter.toFixed(3)} (${impact.toFixed(1)}pp impact)`);

      // $50 is 0.035x b=1440 — barely moves the needle
      assert.ok(impact < 5, `Impact should be <5pp, got ${impact.toFixed(1)}pp`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. Path dependence: equal YES then NO bets
  // ═══════════════════════════════════════════════════════════════════

  describe("path dependence (equal YES then NO bets)", function () {
    it("$50 YES then $50 NO on $10 pool: moderate swings with high b", async function () {
      const market = await createMarket(5, 5);
      await usdc.write.approve([market.address, USDC(100_000)], { account: alice.account });
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const price0 = priceToFloat(await market.read.price());
      console.log(`  Start: ${(price0 * 100).toFixed(1)}%`);

      // $50 YES bet
      await market.write.buyYes([USDC(50)], { account: alice.account });
      const price1 = priceToFloat(await market.read.price());
      console.log(`  After $50 YES: ${(price1 * 100).toFixed(1)}%`);

      // $50 NO bet (with high b, NO is not as cheap so share counts are more balanced)
      await market.write.buyNo([USDC(50)], { account: bob.account });
      const price2 = priceToFloat(await market.read.price());
      console.log(`  After $50 NO: ${(price2 * 100).toFixed(1)}%`);

      // With b=150, $50 causes moderate movement, not extreme swings
      assert.ok(price1 > 0.60, `After YES: price should be >60%, got ${(price1 * 100).toFixed(1)}%`);
      assert.ok(price2 < 0.50, `After NO: price should be <50%, got ${(price2 * 100).toFixed(1)}%`);

      // With high b, the NO bettor still gets more shares (bought at lower price),
      // but the difference is less extreme than with small b.
      const qYes = toFloat18(await market.read.qYes());
      const qNo = toFloat18(await market.read.qNo());
      console.log(`  qYes=${qYes.toFixed(1)}, qNo=${qNo.toFixed(1)} (NO slightly dominates due to path dependence)`);
      assert.ok(qNo > qYes, `qNo should be larger than qYes due to path dependence`);
    });

    it("$50 YES then $50 NO on $100 pool: small swing", async function () {
      const market = await createMarket(50, 50);
      await usdc.write.approve([market.address, USDC(100_000)], { account: alice.account });
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const price0 = priceToFloat(await market.read.price());
      await market.write.buyYes([USDC(50)], { account: alice.account });
      const price1 = priceToFloat(await market.read.price());
      await market.write.buyNo([USDC(50)], { account: bob.account });
      const price2 = priceToFloat(await market.read.price());

      console.log(`  $100 pool: ${(price0 * 100).toFixed(1)}% → ${(price1 * 100).toFixed(1)}% → ${(price2 * 100).toFixed(1)}%`);

      // With b=1500, $50 bets cause small swings
      assert.ok(price1 > 0.50 && price1 < 0.55, `After YES: should be slightly above 50% (50-55%), got ${(price1 * 100).toFixed(1)}%`);
      assert.ok(price2 > 0.45 && price2 < 0.51, `After NO: should come back near center (45-51%), got ${(price2 * 100).toFixed(1)}%`);
    });

    it("$50 YES then $50 NO on $1000 pool: near-symmetric", async function () {
      const market = await createMarket(500, 500);
      await usdc.write.approve([market.address, USDC(100_000)], { account: alice.account });
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const price0 = priceToFloat(await market.read.price());
      await market.write.buyYes([USDC(50)], { account: alice.account });
      const price1 = priceToFloat(await market.read.price());
      await market.write.buyNo([USDC(50)], { account: bob.account });
      const price2 = priceToFloat(await market.read.price());

      console.log(`  $1000 pool: ${(price0 * 100).toFixed(1)}% → ${(price1 * 100).toFixed(1)}% → ${(price2 * 100).toFixed(1)}%`);

      // With 100x more liquidity, equal bets nearly cancel out
      assert.ok(
        Math.abs(price2 - price0) < 0.02,
        `After equal bets on $1000 pool, price should return near 50%. Got ${(price2 * 100).toFixed(1)}%`
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Price after trade matches formula
  // ═══════════════════════════════════════════════════════════════════

  describe("price after trades matches formula", function () {
    it("$100 pool: price after $20 YES matches formula", async function () {
      const market = await createMarket(50, 50);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      await market.write.buyYes([USDC(20)], { account: bob.account });

      const qYes = toFloat18(await market.read.qYes());
      const qNo = toFloat18(await market.read.qNo());
      const b = toFloat18(await market.read.liquidityParameter());
      const onChainPrice = priceToFloat(await market.read.price());

      const expected = expectedPrice(qYes, qNo, b);
      console.log(`  qYes=${qYes.toFixed(2)}, qNo=${qNo.toFixed(2)}, b=${b.toFixed(2)}`);
      console.log(`  Formula: ${(expected * 100).toFixed(3)}%, On-chain: ${(onChainPrice * 100).toFixed(3)}%`);

      assertClose(onChainPrice, expected, 0.5, "$20 YES on $100 pool");
    });

    it("$100 pool: price after $20 YES + $30 NO matches formula", async function () {
      const market = await createMarket(50, 50);
      await usdc.write.approve([market.address, USDC(100_000)], { account: alice.account });
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      await market.write.buyYes([USDC(20)], { account: alice.account });
      await market.write.buyNo([USDC(30)], { account: bob.account });

      const qYes = toFloat18(await market.read.qYes());
      const qNo = toFloat18(await market.read.qNo());
      const b = toFloat18(await market.read.liquidityParameter());
      const onChainPrice = priceToFloat(await market.read.price());

      const expected = expectedPrice(qYes, qNo, b);
      console.log(`  qYes=${qYes.toFixed(2)}, qNo=${qNo.toFixed(2)}, b=${b.toFixed(2)}`);
      console.log(`  Formula: ${(expected * 100).toFixed(3)}%, On-chain: ${(onChainPrice * 100).toFixed(3)}%`);

      assertClose(onChainPrice, expected, 0.5, "$20 YES + $30 NO on $100 pool");
    });

    it("$10 pool: price after $50 YES matches formula", async function () {
      const market = await createMarket(5, 5);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      await market.write.buyYes([USDC(50)], { account: bob.account });

      const qYes = toFloat18(await market.read.qYes());
      const qNo = toFloat18(await market.read.qNo());
      const b = toFloat18(await market.read.liquidityParameter());
      const onChainPrice = priceToFloat(await market.read.price());

      const expected = expectedPrice(qYes, qNo, b);
      console.log(`  qYes=${qYes.toFixed(2)}, qNo=${qNo.toFixed(2)}, b=${b.toFixed(2)}`);
      console.log(`  Formula: ${(expected * 100).toFixed(3)}%, On-chain: ${(onChainPrice * 100).toFixed(3)}%`);

      assertClose(onChainPrice, expected, 0.5, "$50 YES on $10 pool");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Shares received: verify sharesForCost accuracy
  // ═══════════════════════════════════════════════════════════════════

  describe("sharesForCost precision", function () {
    it("should find shares within 1% of target cost", async function () {
      const testCases = [
        { qYes: 50, qNo: 50, b: 144, cost: 10, label: "$10 on balanced $100 pool" },
        { qYes: 50, qNo: 50, b: 144, cost: 50, label: "$50 on balanced $100 pool" },
        { qYes: 5, qNo: 5, b: 14.4, cost: 5, label: "$5 on balanced $10 pool" },
        { qYes: 5, qNo: 5, b: 14.4, cost: 50, label: "$50 on balanced $10 pool" },
        { qYes: 75, qNo: 25, b: 144, cost: 20, label: "$20 NO on 75/25 $100 pool" },
        { qYes: 500, qNo: 500, b: 1440, cost: 100, label: "$100 on balanced $1000 pool" },
      ];

      for (const tc of testCases) {
        const shares = await lmsr.read.sharesForCost([
          e18(tc.cost), e18(tc.qYes), e18(tc.qNo), e18(tc.b), true,
        ]);
        const actualCost = await lmsr.read.buyCost([
          e18(tc.qYes), e18(tc.qNo), shares, e18(tc.b),
        ]);

        const target = e18(tc.cost);
        const waste = target - actualCost; // unused cost
        const wastePct = (Number(waste) / Number(target)) * 100;

        console.log(`  ${tc.label}: shares=${toFloat18(shares).toFixed(2)}, cost=${toFloat18(actualCost).toFixed(4)}/${tc.cost}, waste=${wastePct.toFixed(2)}%`);

        assert.ok(actualCost <= target, `${tc.label}: cost should not exceed target`);
        assert.ok(wastePct < 1, `${tc.label}: waste should be <1%, got ${wastePct.toFixed(2)}%`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. Fee accounting precision
  // ═══════════════════════════════════════════════════════════════════

  describe("fee deduction precision", function () {
    it("should deduct exactly 0.5% fee on each trade", async function () {
      const market = await createMarket(50, 50);
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const betAmounts = [1, 5, 10, 50, 100, 500];
      for (const amount of betAmounts) {
        const feeBefore = await usdc.read.balanceOf([FEE_COLLECTOR]);
        const poolBefore = await usdc.read.balanceOf([market.address]);

        await market.write.buyYes([USDC(amount)], { account: bob.account });

        const feeAfter = await usdc.read.balanceOf([FEE_COLLECTOR]);
        const poolAfter = await usdc.read.balanceOf([market.address]);

        const feeCollected = feeAfter - feeBefore;
        const poolReceived = poolAfter - poolBefore;
        const expectedFee = (USDC(amount) * FEE_BPS) / BPS;
        const expectedNet = USDC(amount) - expectedFee;

        assert.equal(feeCollected, expectedFee,
          `$${amount} bet: fee should be ${formatUnits(expectedFee, 6)}, got ${formatUnits(feeCollected, 6)}`);
        assert.equal(poolReceived, expectedNet,
          `$${amount} bet: pool should receive ${formatUnits(expectedNet, 6)}, got ${formatUnits(poolReceived, 6)}`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. Prices stay consistent with qYes/qNo state
  // ═══════════════════════════════════════════════════════════════════

  describe("price consistency with state", function () {
    it("reading price() should always match priceYes(qYes, qNo, b)", async function () {
      const market = await createMarket(50, 50);
      await usdc.write.approve([market.address, USDC(100_000)], { account: alice.account });
      await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

      const actions: Array<() => Promise<void>> = [
        () => market.write.buyYes([USDC(10)], { account: alice.account }),
        () => market.write.buyNo([USDC(15)], { account: bob.account }),
        () => market.write.buyYes([USDC(30)], { account: alice.account }),
        () => market.write.buyNo([USDC(5)], { account: bob.account }),
        () => market.write.buyYes([USDC(100)], { account: alice.account }),
      ];

      for (let i = 0; i < actions.length; i++) {
        await actions[i]();

        const qYes = await market.read.qYes();
        const qNo = await market.read.qNo();
        const b = await market.read.liquidityParameter();
        const marketPrice = await market.read.price();
        const libraryPrice = await lmsr.read.priceYes([qYes, qNo, b]);

        assert.equal(marketPrice, libraryPrice,
          `After action ${i + 1}: market.price() (${marketPrice}) should equal LMSR.priceYes(${qYes}, ${qNo}, ${b}) (${libraryPrice})`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. Liquidity depth comparison
  // ═══════════════════════════════════════════════════════════════════

  describe("liquidity depth: price impact scales inversely with seed", function () {
    it("same $50 bet causes less impact on larger pools", async function () {
      const seeds = [10, 50, 100, 500, 1000];
      const impacts: number[] = [];

      for (const seed of seeds) {
        const half = seed / 2;
        const market = await createMarket(half, half);
        await usdc.write.approve([market.address, USDC(100_000)], { account: bob.account });

        const priceBefore = priceToFloat(await market.read.price());
        await market.write.buyYes([USDC(50)], { account: bob.account });
        const priceAfter = priceToFloat(await market.read.price());
        const impact = (priceAfter - priceBefore) * 100;
        impacts.push(impact);

        console.log(`  $${seed} seed: ${priceBefore.toFixed(3)} → ${priceAfter.toFixed(3)} (${impact.toFixed(1)}pp impact)`);
      }

      // Each larger pool should have strictly less impact than the previous
      for (let i = 1; i < impacts.length; i++) {
        assert.ok(
          impacts[i] < impacts[i - 1],
          `$${seeds[i]} pool impact (${impacts[i].toFixed(1)}pp) should be less than $${seeds[i - 1]} pool (${impacts[i - 1].toFixed(1)}pp)`
        );
      }
    });
  });
});
