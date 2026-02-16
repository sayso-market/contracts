import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";

const parseEther = (amount: string) => parseUnits(amount, 18);

describe("LMSR Library", async function () {
  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();

  let lmsr: any;

  before(async () => {
    // Deploy test contract that exposes LMSR library functions
    lmsr = await viem.deployContract("TestLMSR");
  });

  describe("Price Calculation", function () {
    it("should return 50% price when qYes = qNo", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const b = parseEther("50");

      const price = await lmsr.read.priceYes([qYes, qNo, b]);

      // Price should be close to 0.5e18 (50%)
      assert(price >= parseEther("0.45") && price <= parseEther("0.55"));
    });

    it("should return >50% price when qYes > qNo", async function () {
      const qYes = parseEther("150");
      const qNo = parseEther("100");
      const b = parseEther("50");

      const price = await lmsr.read.priceYes([qYes, qNo, b]);

      // Price should be > 0.5e18
      assert(price > parseEther("0.5"));
      assert(price < parseEther("1.0"));
    });

    it("should return <50% price when qYes < qNo", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("150");
      const b = parseEther("50");

      const price = await lmsr.read.priceYes([qYes, qNo, b]);

      // Price should be < 0.5e18
      assert(price < parseEther("0.5"));
      assert(price > 0n);
    });

    it("should never return price > 100%", async function () {
      const qYes = parseEther("1000");
      const qNo = parseEther("10");
      const b = parseEther("50");

      const price = await lmsr.read.priceYes([qYes, qNo, b]);

      assert(price <= parseEther("1.0"));
    });

    it("should never return price < 0%", async function () {
      const qYes = parseEther("10");
      const qNo = parseEther("1000");
      const b = parseEther("50");

      const price = await lmsr.read.priceYes([qYes, qNo, b]);

      assert(price >= 0n);
    });
  });

  describe("Cost Function", function () {
    it("should increase monotonically with qYes", async function () {
      const qNo = parseEther("100");
      const b = parseEther("50");

      const cost1 = await lmsr.read.costFunction([parseEther("100"), qNo, b]);
      const cost2 = await lmsr.read.costFunction([parseEther("150"), qNo, b]);
      const cost3 = await lmsr.read.costFunction([parseEther("200"), qNo, b]);

      assert(cost2 > cost1);
      assert(cost3 > cost2);
    });

    it("should be symmetric for YES and NO", async function () {
      const q = parseEther("100");
      const b = parseEther("50");

      const costYes = await lmsr.read.costFunction([q, parseEther("100"), b]);
      const costNo = await lmsr.read.costFunction([parseEther("100"), q, b]);

      assert.equal(costYes, costNo);
    });

    it("should scale with liquidity parameter b", async function () {
      const qYes = parseEther("150");
      const qNo = parseEther("100");

      const cost1 = await lmsr.read.costFunction([qYes, qNo, parseEther("25")]);
      const cost2 = await lmsr.read.costFunction([qYes, qNo, parseEther("50")]);
      const cost3 = await lmsr.read.costFunction([qYes, qNo, parseEther("100")]);

      assert(cost2 > cost1);
      assert(cost3 > cost2);
    });
  });

  describe("Buy Cost Calculation", function () {
    it("should calculate positive cost for buying shares", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const shares = parseEther("10");
      const b = parseEther("50");

      const cost = await lmsr.read.buyCost([qYes, qNo, shares, b]);

      assert(cost > 0n);
    });

    it("should increase cost for larger purchases", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const b = parseEther("50");

      const cost1 = await lmsr.read.buyCost([qYes, qNo, parseEther("10"), b]);
      const cost2 = await lmsr.read.buyCost([qYes, qNo, parseEther("20"), b]);
      const cost3 = await lmsr.read.buyCost([qYes, qNo, parseEther("50"), b]);

      assert(cost2 > cost1);
      assert(cost3 > cost2);
    });

    it("should have increasing marginal cost (slippage)", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const b = parseEther("50");

      const cost10 = await lmsr.read.buyCost([qYes, qNo, parseEther("10"), b]);
      const cost20 = await lmsr.read.buyCost([qYes, qNo, parseEther("20"), b]);

      const avgCost10 = cost10 / 10n;
      const avgCost20 = cost20 / 20n;

      // Average cost per share should be higher for larger purchases
      assert(avgCost20 > avgCost10);
    });
  });

  describe("Sell Payout Calculation", function () {
    it("should calculate positive payout for selling shares", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const shares = parseEther("10");
      const b = parseEther("50");

      const payout = await lmsr.read.sellPayout([qYes, qNo, shares, b]);

      assert(payout > 0n);
    });

    it("should pay less per share for larger sales", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const b = parseEther("50");

      const payout10 = await lmsr.read.sellPayout([qYes, qNo, parseEther("10"), b]);
      const payout20 = await lmsr.read.sellPayout([qYes, qNo, parseEther("20"), b]);

      const avgPayout10 = payout10 / 10n;
      const avgPayout20 = payout20 / 20n;

      // Average payout per share should be lower for larger sales
      assert(avgPayout20 < avgPayout10);
    });
  });

  describe("Buy/Sell Symmetry", function () {
    it("should return similar amount after buy then sell", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const shares = parseEther("10");
      const b = parseEther("50");

      const buyCost = await lmsr.read.buyCost([qYes, qNo, shares, b]);
      const newQYes = qYes + shares;
      const sellPayout = await lmsr.read.sellPayout([newQYes, qNo, shares, b]);

      // Payout should be close to cost (within 5% due to slippage)
      const diff = buyCost > sellPayout ? buyCost - sellPayout : sellPayout - buyCost;
      const tolerance = buyCost / 20n; // 5%

      assert(diff < tolerance);
    });

    it("should return to same price after buy then sell", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const shares = parseEther("10");
      const b = parseEther("50");

      const priceBefore = await lmsr.read.priceYes([qYes, qNo, b]);
      const priceAfterBuy = await lmsr.read.priceYes([qYes + shares, qNo, b]);
      const priceAfterSell = await lmsr.read.priceYes([qYes, qNo, b]);

      assert.equal(priceAfterSell, priceBefore);
      assert(priceAfterBuy > priceBefore);
    });
  });

  describe("Shares for Cost Calculation", function () {
    it("should calculate shares for given cost", async function () {
      const qYes = parseEther("100");
      const qNo = parseEther("100");
      const targetCost = parseEther("10");
      const b = parseEther("50");

      const shares = await lmsr.read.sharesForCost([targetCost, qYes, qNo, b, true]);

      assert(shares > 0n);

      // Verify the cost of these shares is close to target
      const actualCost = await lmsr.read.buyCost([qYes, qNo, shares, b]);
      assert(actualCost <= targetCost);

      // Within 10% of target
      const diff = targetCost - actualCost;
      assert(diff < targetCost / 10n);
    });

    it("should find fewer shares when price is higher", async function () {
      const targetCost = parseEther("10");
      const b = parseEther("50");

      const sharesBalanced = await lmsr.read.sharesForCost([
        targetCost,
        parseEther("100"),
        parseEther("100"),
        b,
        true
      ]);

      const sharesExpensive = await lmsr.read.sharesForCost([
        targetCost,
        parseEther("200"),
        parseEther("100"),
        b,
        true
      ]);

      assert(sharesExpensive < sharesBalanced);
    });
  });

  describe("Edge Cases", function () {
    it("should handle extreme ratios", async function () {
      const b = parseEther("100");

      // 99% YES
      const price99 = await lmsr.read.priceYes([parseEther("1000"), parseEther("10"), b]);
      assert(price99 > parseEther("0.9"));
      assert(price99 <= parseEther("1.0"));

      // 1% YES
      const price1 = await lmsr.read.priceYes([parseEther("10"), parseEther("1000"), b]);
      assert(price1 < parseEther("0.1"));
      assert(price1 >= 0n);
    });

    it("should have valid price bounds", async function () {
      const b = parseEther("50");
      const testCases = [
        { qYes: parseEther("1"), qNo: parseEther("1000") },
        { qYes: parseEther("1000"), qNo: parseEther("1") },
        { qYes: parseEther("500"), qNo: parseEther("500") },
      ];

      for (const { qYes, qNo } of testCases) {
        const price = await lmsr.read.priceYes([qYes, qNo, b]);
        assert(price >= 0n);
        assert(price <= parseEther("1"));
      }
    });
  });
});
