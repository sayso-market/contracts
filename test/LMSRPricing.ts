import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { formatUnits } from "viem";

const USDC = (amount: number) => BigInt(amount * 1_000_000);
const SAYSO = (amount: number) => BigInt(amount) * 10n ** 18n;
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("LMSR Pricing Correctness", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [alice, bob, charlie] = await viem.getWalletClients();

  async function mineBlocks(count: number) {
    for (let i = 0; i < count; i++) {
      await provider.send("evm_mine");
    }
  }

  async function advanceTime(seconds: number) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine");
  }

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  // Deploy contracts
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

  // Mint USDC to users
  await usdc.write.mint([alice.account.address, USDC(10_000)]);
  await usdc.write.mint([bob.account.address, USDC(10_000)]);
  await usdc.write.mint([charlie.account.address, USDC(10_000)]);

  let market: any;

  describe("NO side pricing uses correct cost curve parameters", function () {
    it("NO shares should be cheaper in YES-heavy market", async function () {
      // Create market with 100 USDC seed (larger market to handle bigger trades)
      const now = await getNow();
      await usdc.write.approve([factory.address, USDC(100)], {
        account: alice.account,
      });

      const tx = await factory.write.createMarket(
        [
          "Will ETH hit $5k?",
          now,        // effectiveFrom: now
          now + 200,  // effectiveTo: now + 200
          now + 300,  // resolutionOpen: now + 300
          now + 400,  // resolutionClose: now + 400
          USDC(50),
          USDC(50),
        ],
        { account: alice.account }
      );

      const markets = await factory.read.getMarkets([0n, 1n]);
      market = await viem.getContractAt("AMM", markets[0]);

      // Trading period is from effectiveFrom (now) to effectiveTo (now + 200)
      // No need to advance time, we're already in the trading period

      // Approve USDC for trading
      await usdc.write.approve([market.address, USDC(10_000)], {
        account: alice.account,
      });
      await usdc.write.approve([market.address, USDC(10_000)], {
        account: bob.account,
      });

      // Alice buys 150 USDC of YES to create imbalance (3x the initial liquidity)
      const aliceYesBefore = await market.read.yesBalances([
        alice.account.address,
      ]);
      await market.write.buyYes([USDC(150)], { account: alice.account });
      const aliceYesAfter = await market.read.yesBalances([
        alice.account.address,
      ]);
      const aliceYesShares = aliceYesAfter - aliceYesBefore;

      console.log(
        `  Alice bought 150 USDC YES, received ${formatUnits(aliceYesShares, 18)} shares`
      );

      // Check price - should be heavily YES-biased
      const priceAfterAlice = await market.read.price();
      const pricePercent = Number(priceAfterAlice) / 1e16;
      console.log(`  Price after Alice buy: ${pricePercent.toFixed(2)}%`);

      // Bob buys 100 USDC of NO - should get MORE shares than Alice (NO is cheap)
      const bobNoBefore = await market.read.noBalances([bob.account.address]);
      await market.write.buyNo([USDC(100)], { account: bob.account });
      const bobNoAfter = await market.read.noBalances([bob.account.address]);
      const bobNoShares = bobNoAfter - bobNoBefore;

      console.log(
        `  Bob bought 100 USDC NO, received ${formatUnits(bobNoShares, 18)} shares`
      );

      // For comparison: what would 100 USDC YES buy now?
      const charlieYesBefore = await market.read.yesBalances([
        charlie.account.address,
      ]);
      await usdc.write.approve([market.address, USDC(10_000)], {
        account: charlie.account,
      });
      await market.write.buyYes([USDC(100)], { account: charlie.account });
      const charlieYesAfter = await market.read.yesBalances([
        charlie.account.address,
      ]);
      const charlieYesShares = charlieYesAfter - charlieYesBefore;

      console.log(
        `  Charlie bought 100 USDC YES, received ${formatUnits(charlieYesShares, 18)} shares`
      );

      // EXPECTED: NO is cheap (price < 50%), so Bob should get MORE shares than Charlie
      console.log(
        `  Ratio: Bob NO shares / Charlie YES shares = ${(Number(bobNoShares) / Number(charlieYesShares)).toFixed(2)}`
      );

      assert.ok(
        bobNoShares > charlieYesShares,
        `Bob (NO, cheap side) should get MORE shares than Charlie (YES, expensive side) for same 100 USDC. ` +
          `Got Bob: ${formatUnits(bobNoShares, 18)}, Charlie: ${formatUnits(charlieYesShares, 18)}.`
      );
    });
  });

  describe("LMSR binary search finds correct shares for cheap prices", function () {
    it("should receive correct shares when buying cheap side", async function () {
      // Create market with 100 USDC seed
      const now = await getNow();
      await usdc.write.approve([factory.address, USDC(100)], {
        account: alice.account,
      });

      await factory.write.createMarket(
        [
          "Will SOL hit $200?",
          now,        // effectiveFrom: now
          now + 200,  // effectiveTo: now + 200
          now + 300,  // resolutionOpen: now + 300
          now + 400,  // resolutionClose: now + 400
          USDC(50),
          USDC(50),
        ],
        { account: alice.account }
      );

      const allMarkets = await factory.read.getMarkets([0n, 10n]);
      market = await viem.getContractAt("AMM", allMarkets[allMarkets.length - 1]);

      // Trading period is from effectiveFrom (now) to effectiveTo (now + 200)
      // No need to advance time, we're already in the trading period

      // Approve USDC
      await usdc.write.approve([market.address, USDC(10_000)], {
        account: alice.account,
      });
      await usdc.write.approve([market.address, USDC(10_000)], {
        account: bob.account,
      });

      // Alice buys 100 USDC NO to make YES cheap (2x initial liquidity)
      await market.write.buyNo([USDC(100)], { account: alice.account });

      const priceAfter = await market.read.price();
      const pricePercent = Number(priceAfter) / 1e16;
      console.log(`  YES price: ${pricePercent.toFixed(2)}%`);

      // Bob tries to buy 50 USDC of YES (the cheap side)
      const bobBalanceBefore = await usdc.read.balanceOf([
        bob.account.address,
      ]);
      const bobYesBefore = await market.read.yesBalances([bob.account.address]);

      await market.write.buyYes([USDC(50)], { account: bob.account });

      const bobBalanceAfter = await usdc.read.balanceOf([bob.account.address]);
      const bobYesAfter = await market.read.yesBalances([bob.account.address]);

      const usdcSpent = bobBalanceBefore - bobBalanceAfter;
      const yesSharesReceived = bobYesAfter - bobYesBefore;

      console.log(`  Bob spent: ${formatUnits(usdcSpent, 6)} USDC`);
      console.log(
        `  Bob received: ${formatUnits(yesSharesReceived, 18)} YES shares`
      );

      // Calculate effective share price
      const effectiveSharePrice =
        (Number(usdcSpent) / 1e6 / Number(yesSharesReceived)) * 1e18;
      console.log(
        `  Effective price per share: ${effectiveSharePrice.toFixed(2)}%`
      );

      // At 25% price, 50 USDC (49.75 after fees) should buy ~130-150 shares
      // Binary search upper bound must be large enough to find the correct amount

      const minExpectedShares = 120n * 10n ** 18n; // At least 120 shares for 50 USDC at 25% price

      assert.ok(
        yesSharesReceived >= minExpectedShares,
        `Bob should receive at least ${formatUnits(minExpectedShares, 18)} shares when buying cheap YES at 25% price. ` +
          `Got ${formatUnits(yesSharesReceived, 18)} shares.`
      );
    });
  });
});
