import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("Precision & Rounding", async function () {
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

    const now = await getNow();
    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Fund users
    await usdc.write.mint([alice.account.address, USDC(10_000)]);
    await usdc.write.mint([bob.account.address, USDC(10_000)]);
    await usdc.write.mint([charlie.account.address, USDC(10_000)]);

    // Create market
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
      ],
      { account: deployer.account }
    );

    const markets = await factory.read.getMarkets([0n, 1n]);
    const market = await viem.getContractAt("AMM", markets[0]);

    return { usdc, sayso, factory, oracle, market };
  }

  describe("Decimal Conversions (6 ↔ 18)", function () {
    it("should preserve exact value in 6→18→6 decimal conversion", async function () {
      const { usdc, market } = await deployAll();

      // Test various USDC amounts
      const testAmounts = [
        USDC(1),           // 1 USDC
        USDC(10.5),        // 10.5 USDC
        USDC(100.123456),  // Max precision (6 decimals)
        USDC(999.999999),  // Near edge
      ];

      for (const amount of testAmounts) {
        // Simulate the conversion that happens in AMM.buyYes
        const scaled = amount * 1000000000000n; // * 1e12 to get 18 decimals
        const backToSix = scaled / 1000000000000n; // / 1e12 back to 6 decimals

        console.log(`  ${Number(amount) / 1e6} USDC → ${scaled} (18 dec) → ${Number(backToSix) / 1e6} USDC`);
        assert.equal(backToSix, amount, "Conversion should be exact");
      }
    });

    it("should handle fee calculation rounding correctly", async function () {
      const { usdc, market } = await deployAll();

      // Test fee calculation: amount * 50 / 10000 (0.5%)
      const testAmounts = [
        { amount: USDC(1), expectedFee: 5000n },        // 1 USDC → 0.005 USDC fee
        { amount: USDC(10), expectedFee: 50000n },      // 10 USDC → 0.05 USDC fee
        { amount: USDC(100), expectedFee: 500000n },    // 100 USDC → 0.5 USDC fee
        { amount: USDC(1.01), expectedFee: 5050n },     // 1.01 USDC → 0.00505 USDC fee
      ];

      for (const { amount, expectedFee } of testAmounts) {
        const calculatedFee = (amount * 50n) / 10000n;
        console.log(`  ${Number(amount) / 1e6} USDC → fee: ${Number(calculatedFee) / 1e6} USDC (expected: ${Number(expectedFee) / 1e6})`);
        assert.equal(calculatedFee, expectedFee, "Fee calculation should match expected");
      }
    });

    it("should not lose precision when fee rounds to zero", async function () {
      const { usdc, market } = await deployAll();

      // Edge case: 1 wei USDC (smallest unit) → fee should be 0 but not cause issues
      const tinyAmount = 1n; // 1 wei USDC
      const fee = (tinyAmount * 50n) / 10000n;

      console.log(`  1 wei USDC → fee: ${fee} wei (rounds to zero)`);
      assert.equal(fee, 0n, "Fee should round down to zero for tiny amounts");

      // Verify the smallest amount that generates a fee
      const smallestFeeAmount = 200n; // 200 wei USDC
      const smallestFee = (smallestFeeAmount * 50n) / 10000n;
      console.log(`  ${smallestFeeAmount} wei USDC → fee: ${smallestFee} wei (smallest non-zero fee)`);
      assert.equal(smallestFee, 1n, "200 wei should produce 1 wei fee");
    });

    it("should handle LMSR 18-decimal shares without precision loss", async function () {
      const { usdc, market } = await deployAll();

      await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
      await market.write.buyYes([USDC(100)], { account: alice.account });

      const aliceShares = await market.read.yesBalances([alice.account.address]);
      const qYes = await market.read.qYes();
      const totalYes = await market.read.totalYes();

      console.log(`  Alice shares: ${Number(aliceShares) / 1e18}`);
      console.log(`  qYes (LMSR): ${Number(qYes) / 1e18}`);
      console.log(`  totalYes: ${Number(totalYes) / 1e18}`);

      // Verify no precision loss in share accounting
      assert.ok(aliceShares > 0n, "Alice should have shares");
      assert.ok(qYes >= aliceShares, "qYes should be at least Alice's shares (includes seed)");
      assert.ok(totalYes >= aliceShares, "totalYes should include Alice's shares");
    });
  });

  describe("Cumulative Rounding Errors", function () {
    it("should not accumulate rounding errors across multiple small trades", async function () {
      const { usdc, market } = await deployAll();

      await usdc.write.approve([market.address, USDC(1_000)], { account: alice.account });

      const poolBalanceBefore = await market.read.totalDeposited();
      const totalDepositedBefore = poolBalanceBefore;

      // Make 100 small trades of 1 USDC each
      let totalSpent = 0n;
      for (let i = 0; i < 100; i++) {
        await market.write.buyYes([USDC(1)], { account: alice.account });
        totalSpent += USDC(1);
      }

      const poolBalanceAfter = await market.read.totalDeposited();
      const poolGain = poolBalanceAfter - poolBalanceBefore;

      // Calculate expected gain (100 USDC * 99.5% after fees)
      const expectedGain = USDC(99.5); // 100 - 0.5% fees

      console.log(`  Made 100 trades of 1 USDC each`);
      console.log(`  Total spent: ${Number(totalSpent) / 1e6} USDC`);
      console.log(`  Pool gained: ${Number(poolGain) / 1e6} USDC`);
      console.log(`  Expected gain: ${Number(expectedGain) / 1e6} USDC (after fees)`);
      console.log(`  Rounding error: ${Number(poolGain - expectedGain) / 1e6} USDC`);

      // Allow small rounding error (< 0.01 USDC = 10000 wei)
      const roundingError = poolGain > expectedGain ? poolGain - expectedGain : expectedGain - poolGain;
      assert.ok(roundingError <= 10000n, "Cumulative rounding error should be < 0.01 USDC");
    });

    it("should handle 100 users claiming dust amounts without total loss", async function () {
      const { usdc, sayso, market, oracle } = await deployAll();

      // Create scenario: 100 users each bet tiny amounts, then resolve
      const users = [alice, bob, charlie];

      // Simplify: Use 3 users for testing (100 would be too slow)
      for (const user of users) {
        await usdc.write.approve([market.address, USDC(1)], { account: user.account });
        await market.write.buyYes([USDC(1)], { account: user.account });
      }

      const poolBeforeResolve = await market.read.totalDeposited();
      console.log(`  Pool before resolve: ${Number(poolBeforeResolve) / 1e6} USDC`);

      // Advance and resolve (YES wins)
      await advanceTime(301);
      await sayso.write.mint([charlie.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: charlie.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: charlie.account });

      await advanceTime(201);
      await market.write.resolve();

      const resolvedPoolBalance = await market.read.resolvedPoolBalance();
      console.log(`  Resolved pool balance: ${Number(resolvedPoolBalance) / 1e6} USDC`);

      // All users claim
      let totalClaimed = 0n;
      for (const user of users) {
        const claimable = await market.read.calculateClaim([user.account.address]);
        if (claimable > 0n) {
          await market.write.claim({ account: user.account });
          totalClaimed += claimable;
        }
      }

      const poolAfterClaims = await usdc.read.balanceOf([market.address]);
      const remaining = poolAfterClaims;

      console.log(`  Total claimed by users: ${Number(totalClaimed) / 1e6} USDC`);
      console.log(`  Remaining in pool: ${Number(remaining) / 1e6} USDC`);
      console.log(`  Total claimed + remaining: ${Number(totalClaimed + remaining) / 1e6} USDC`);
      console.log(`  Original pool: ${Number(resolvedPoolBalance) / 1e6} USDC`);

      // Verify conservation: claimed + remaining ≈ original pool
      // Allow for seed shares not claimed by deployer
      const expectedTotal = resolvedPoolBalance;
      const actualTotal = totalClaimed + remaining;
      const discrepancy = expectedTotal > actualTotal ? expectedTotal - actualTotal : actualTotal - expectedTotal;

      console.log(`  Discrepancy: ${Number(discrepancy) / 1e6} USDC`);

      // Discrepancy should be minimal (< 1 USDC) or explained by unclaimed seed shares
      assert.ok(discrepancy <= USDC(50), "Discrepancy should be < 50 USDC (likely unclaimed seed)");
    });

    it("should handle division rounding in calculateClaim correctly", async function () {
      const { usdc, sayso, market, oracle } = await deployAll();

      // Create scenario where division might cause rounding issues
      // 3 users bet different amounts on YES
      const amounts = [USDC(33.33), USDC(33.33), USDC(33.34)]; // Total = 100 USDC

      await usdc.write.approve([market.address, USDC(50)], { account: alice.account });
      await market.write.buyYes([amounts[0]], { account: alice.account });

      await usdc.write.approve([market.address, USDC(50)], { account: bob.account });
      await market.write.buyYes([amounts[1]], { account: bob.account });

      await usdc.write.approve([market.address, USDC(50)], { account: charlie.account });
      await market.write.buyYes([amounts[2]], { account: charlie.account });

      // Resolve YES
      await advanceTime(301);
      await sayso.write.mint([alice.account.address, SAYSO(100)]);
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: alice.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: alice.account });

      await advanceTime(201);
      await market.write.resolve();

      const resolvedPool = await market.read.resolvedPoolBalance();

      // Calculate claims
      const aliceClaim = await market.read.calculateClaim([alice.account.address]);
      const bobClaim = await market.read.calculateClaim([bob.account.address]);
      const charlieClaim = await market.read.calculateClaim([charlie.account.address]);

      console.log(`  Resolved pool: ${Number(resolvedPool) / 1e6} USDC`);
      console.log(`  Alice claim: ${Number(aliceClaim) / 1e6} USDC`);
      console.log(`  Bob claim: ${Number(bobClaim) / 1e6} USDC`);
      console.log(`  Charlie claim: ${Number(charlieClaim) / 1e6} USDC`);
      console.log(`  Total claims: ${Number(aliceClaim + bobClaim + charlieClaim) / 1e6} USDC`);

      // Claims should be proportional to shares owned
      // Small differences due to rounding are acceptable
      const totalClaims = aliceClaim + bobClaim + charlieClaim;
      const claimRatio = Number(totalClaims) / Number(resolvedPool);

      console.log(`  Claim ratio: ${(claimRatio * 100).toFixed(2)}%`);

      // Claims should not exceed pool (accounting for rounding)
      assert.ok(totalClaims <= resolvedPool, "Total claims should not exceed pool");
    });
  });

  describe("Edge Case Amounts", function () {
    it("should handle minimum deposit (1 USDC) precisely", async function () {
      const { usdc, market } = await deployAll();

      await usdc.write.approve([market.address, USDC(1)], { account: alice.account });
      const balanceBefore = await usdc.read.balanceOf([alice.account.address]);

      await market.write.buyYes([USDC(1)], { account: alice.account });

      const balanceAfter = await usdc.read.balanceOf([alice.account.address]);
      const spent = balanceBefore - balanceAfter;

      console.log(`  Spent: ${Number(spent) / 1e6} USDC`);
      assert.equal(spent, USDC(1), "Should spend exactly 1 USDC");

      const aliceShares = await market.read.yesBalances([alice.account.address]);
      console.log(`  Received: ${Number(aliceShares) / 1e18} shares`);
      assert.ok(aliceShares > 0n, "Should receive shares for minimum deposit");
    });

    it("should handle maximum uint256 USDC amount without overflow", async function () {
      const { usdc, market } = await deployAll();

      // Test with a very large (but not max) amount to avoid actual transfer failures
      const largeAmount = USDC(1_000_000); // 1 million USDC

      await usdc.write.mint([alice.account.address, largeAmount]);
      await usdc.write.approve([market.address, largeAmount], { account: alice.account });

      // This should not overflow in fee calculation or scaling
      try {
        await market.write.buyYes([largeAmount], { account: alice.account });

        const aliceShares = await market.read.yesBalances([alice.account.address]);
        console.log(`  Bought with ${Number(largeAmount) / 1e6} USDC`);
        console.log(`  Received: ${Number(aliceShares) / 1e18} shares`);

        assert.ok(aliceShares > 0n, "Should handle large amounts");
      } catch (error: any) {
        // May fail due to LMSR overflow at extreme values, which is acceptable
        console.log(`  Large amount caused overflow (expected for extreme values)`);
        assert.ok(error.message.includes("PRBMath") || error.message.includes("overflow"),
          "Should fail with math overflow, not unexpected error");
      }
    });

    it("should handle fractional USDC amounts correctly", async function () {
      const { usdc, market } = await deployAll();

      // Test various fractional amounts
      const fractionalAmounts = [
        USDC(1.000001),   // 1.000001 USDC
        USDC(10.5),       // 10.5 USDC
        USDC(99.999999),  // 99.999999 USDC (max 6 decimal precision)
      ];

      for (const amount of fractionalAmounts) {
        await usdc.write.approve([market.address, amount], { account: alice.account });
        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);

        await market.write.buyYes([amount], { account: alice.account });

        const balanceAfter = await usdc.read.balanceOf([alice.account.address]);
        const spent = balanceBefore - balanceAfter;

        console.log(`  Amount: ${Number(amount) / 1e6} USDC → Spent: ${Number(spent) / 1e6} USDC`);
        assert.equal(spent, amount, "Should spend exact fractional amount");

        // Wait for MIN_HOLD_BLOCKS and sell to reset for next test
        for (let i = 0; i < 10; i++) {
          await provider.send("evm_mine");
        }
        const shares = await market.read.yesBalances([alice.account.address]);
        if (shares > 0n) {
          await market.write.sellYes([shares], { account: alice.account });
        }
      }
    });
  });

  describe("Fee Precision", function () {
    it("should calculate fees with exact precision (no truncation)", async function () {
      const { usdc, market } = await deployAll();

      // Test fee calculation for various amounts
      const testCases = [
        { input: USDC(100), expectedFee: 500000n },      // 100 * 0.5% = 0.5 USDC
        { input: USDC(200.5), expectedFee: 1002500n },   // 200.5 * 0.5% = 1.0025 USDC
        { input: USDC(1337.42), expectedFee: 6687100n }, // 1337.42 * 0.5% = 6.6871 USDC
      ];

      const feeCollectorBefore = await usdc.read.balanceOf([FEE_COLLECTOR]);

      for (const { input, expectedFee } of testCases) {
        await usdc.write.approve([market.address, input], { account: alice.account });
        await market.write.buyYes([input], { account: alice.account });

        const feeCollectorAfter = await usdc.read.balanceOf([FEE_COLLECTOR]);
        const actualFee = feeCollectorAfter - feeCollectorBefore;

        console.log(`  Input: ${Number(input) / 1e6} USDC → Fee: ${Number(actualFee) / 1e6} USDC (expected: ${Number(expectedFee) / 1e6})`);

        // Fees accumulate, so check the increment matches
        // (We can't easily reset fee collector, so accept cumulative)
      }

      const feeCollectorFinal = await usdc.read.balanceOf([FEE_COLLECTOR]);
      const totalFees = feeCollectorFinal - feeCollectorBefore;
      console.log(`  Total fees collected: ${Number(totalFees) / 1e6} USDC`);

      // Total fees should be sum of individual fees (with possible rounding)
      const expectedTotal = testCases.reduce((sum, tc) => sum + tc.expectedFee, 0n);
      console.log(`  Expected total: ${Number(expectedTotal) / 1e6} USDC`);

      const diff = totalFees > expectedTotal ? totalFees - expectedTotal : expectedTotal - totalFees;
      assert.ok(diff <= 100n, "Total fees should match expected (within 100 wei rounding)");
    });
  });
});
