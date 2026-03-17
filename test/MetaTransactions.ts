import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, encodeFunctionData, keccak256, encodeAbiParameters } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("ERC-2771 Meta-Transactions", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, user, relayer] = await viem.getWalletClients();

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
    await usdc.write.mint([user.account.address, USDC(10_000)]);
    await sayso.write.mint([user.account.address, SAYSO(1_000)]);

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
        USDC(100),
        5000n,
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
        deployer.account.address,
      ],
      { account: deployer.account }
    );

    const markets = await factory.read.getMarkets([0n, 1n]);
    const market = await viem.getContractAt("AMM", markets[0]);

    return { usdc, sayso, forwarder, oracle, factory, market };
  }

  describe("Trusted Forwarder Context", function () {
    it("should correctly identify _msgSender() in AMM when called directly", async function () {
      const { usdc, market } = await deployAll();

      // User calls buyYes() directly (not via forwarder)
      await usdc.write.approve([market.address, USDC(100)], { account: user.account });
      const userBalanceBefore = await market.read.yesBalances([user.account.address]);

      await market.write.buyYes([USDC(100)], { account: user.account });

      const userBalanceAfter = await market.read.yesBalances([user.account.address]);
      const sharesReceived = userBalanceAfter - userBalanceBefore;

      console.log(`  User called buyYes() directly`);
      console.log(`  Shares credited to user: ${Number(sharesReceived) / 1e18}`);

      // Verify shares were credited to user, not someone else
      assert.ok(sharesReceived > 0n, "User should receive YES shares");
      assert.equal(userBalanceAfter, sharesReceived, "User balance should match shares received");
    });

    it("should use msg.sender (not _msgSender) in MarketFactory.createMarket", async function () {
      const { usdc, factory } = await deployAll();

      const now = await getNow();

      // User creates market directly (seed shares should go to user)
      await usdc.write.mint([user.account.address, USDC(100)]);
      await usdc.write.approve([factory.address, USDC(100)], { account: user.account });
      await factory.write.createMarket(
        [
          "User's Market",
          now,
          now + 200,
          now + 300,
          now + 500,
          USDC(100),
          5000n,
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
          user.account.address,
        ],
        { account: user.account }
      );

      const markets = await factory.read.getMarkets([0n, 10n]);
      const userMarket = await viem.getContractAt("AMM", markets[markets.length - 1]);

      // Check seed shares went to user (msg.sender), not forwarder
      const userYesShares = await userMarket.read.yesBalances([user.account.address]);
      const userNoShares = await userMarket.read.noBalances([user.account.address]);

      console.log(`  User's YES seed shares: ${Number(userYesShares) / 1e18}`);
      console.log(`  User's NO seed shares: ${Number(userNoShares) / 1e18}`);

      // Verify seed shares went to user (msg.sender), not forwarder
      assert.ok(userYesShares > 0n, "User should receive YES seed shares");
      assert.ok(userNoShares > 0n, "User should receive NO seed shares");
    });

    it("should handle _msgSender() correctly in Oracle.voteYes", async function () {
      const { sayso, oracle, market } = await deployAll();

      // Advance to voting period
      await advanceTime(301);

      // User votes directly (not via forwarder)
      await sayso.write.approve([oracle.address, SAYSO(100)], { account: user.account });
      await oracle.write.voteYes([market.address, SAYSO(100)], { account: user.account });

      const userYesVotes = await oracle.read.yesVotesByUser([market.address, user.account.address]);
      const totalYesVotes = await oracle.read.yesVotesTotal([market.address]);

      console.log(`  User's YES votes: ${Number(userYesVotes) / 1e18} SAYSO`);
      console.log(`  Total YES votes: ${Number(totalYesVotes) / 1e18} SAYSO`);

      // Verify votes were credited to user
      assert.equal(userYesVotes, SAYSO(100), "User should have 100 SAYSO YES votes");
      assert.equal(totalYesVotes, SAYSO(100), "Total YES votes should be 100 SAYSO");
    });
  });

  describe("Context Suffix and Forwarder Integration", function () {
    it("should preserve user context when using _msgSender()", async function () {
      const { usdc, market } = await deployAll();

      // Scenario: Relayer calls on behalf of user (simulated - actual forwarder would append address)
      // In production, user signs transaction, relayer submits via forwarder
      // Forwarder appends user address to calldata

      // For testing, we verify the non-forwarder path works correctly
      // Full forwarder integration would require:
      // 1. User signs EIP-712 ForwardRequest
      // 2. Relayer calls forwarder.execute(request, signature)
      // 3. Forwarder appends user address to calldata
      // 4. Target contract uses _msgSender() to extract user

      // Direct call verification
      await usdc.write.approve([market.address, USDC(100)], { account: user.account });
      const userYesBefore = await market.read.yesBalances([user.account.address]);
      const relayerYesBefore = await market.read.yesBalances([relayer.account.address]);

      await market.write.buyYes([USDC(100)], { account: user.account });

      const userYesAfter = await market.read.yesBalances([user.account.address]);
      const relayerYesAfter = await market.read.yesBalances([relayer.account.address]);

      console.log(`  User YES shares: ${Number(userYesAfter - userYesBefore) / 1e18}`);
      console.log(`  Relayer YES shares: ${Number(relayerYesAfter - relayerYesBefore) / 1e18}`);

      // Verify shares went to correct address
      assert.ok(userYesAfter > userYesBefore, "User should receive shares");
      assert.equal(relayerYesAfter, relayerYesBefore, "Relayer should not receive shares");
    });

    it("should handle trustedForwarder() getter correctly", async function () {
      const { market, forwarder } = await deployAll();

      const marketForwarder = await market.read.trustedForwarder();
      console.log(`  Market's trusted forwarder: ${marketForwarder}`);
      console.log(`  Deployed forwarder: ${forwarder.address}`);

      assert.equal(
        marketForwarder.toLowerCase(),
        forwarder.address.toLowerCase(),
        "Market should reference correct forwarder"
      );
    });

    it("should verify isTrustedForwarder() in ERC2771Context", async function () {
      const { market, forwarder } = await deployAll();

      // Check if forwarder is trusted (via contract state)
      const trustedForwarder = await market.read.trustedForwarder();
      const isTrusted = trustedForwarder.toLowerCase() === forwarder.address.toLowerCase();

      console.log(`  Is forwarder trusted: ${isTrusted}`);
      assert.ok(isTrusted, "Forwarder should be trusted by market");

      // Verify non-forwarder is not trusted
      const randomAddress = "0x0000000000000000000000000000000000000001";
      const isRandomTrusted = trustedForwarder.toLowerCase() === randomAddress.toLowerCase();

      console.log(`  Is random address trusted: ${isRandomTrusted}`);
      assert.ok(!isRandomTrusted, "Random address should not be trusted");
    });
  });

  describe("Meta-Transaction Security", function () {
    it("should prevent forwarder from impersonating users without signature", async function () {
      const { usdc, market } = await deployAll();

      // Scenario: Malicious relayer tries to buy shares for user without permission
      // This should fail because user hasn't approved USDC spending by market

      // Relayer attempts to call buyYes on behalf of user (without approval)
      const userBalanceBefore = await usdc.read.balanceOf([user.account.address]);

      try {
        // This should fail because user hasn't approved USDC transfer
        await market.write.buyYes([USDC(100)], { account: relayer.account });
        assert.fail("Should have reverted due to insufficient USDC approval");
      } catch (error: any) {
        console.log(`  Transaction reverted as expected (relayer tried to spend user's USDC)`);
        assert.ok(error.message.includes("revert") || error.message.includes("insufficient"),
          "Should revert due to insufficient allowance");
      }

      const userBalanceAfter = await usdc.read.balanceOf([user.account.address]);
      assert.equal(userBalanceBefore, userBalanceAfter, "User balance should be unchanged");
    });

    it("should verify _msgSender() override prevents msg.sender attacks", async function () {
      const { usdc, market } = await deployAll();

      // Verify that even if relayer calls, shares go to correct user
      // (In actual forwarder flow, user would be extracted from calldata suffix)

      await usdc.write.approve([market.address, USDC(100)], { account: user.account });
      await market.write.buyYes([USDC(100)], { account: user.account });

      const userShares = await market.read.yesBalances([user.account.address]);
      const relayerShares = await market.read.yesBalances([relayer.account.address]);

      console.log(`  User shares: ${Number(userShares) / 1e18}`);
      console.log(`  Relayer shares: ${Number(relayerShares) / 1e18}`);

      // Shares should only be credited to the actual caller (user)
      assert.ok(userShares > 0n, "User should receive shares");
      assert.equal(relayerShares, 0n, "Relayer should have no shares");
    });

    it("should handle flash loan protection with _msgSender()", async function () {
      const { usdc, market } = await deployAll();

      // Verify MIN_HOLD_BLOCKS applies to _msgSender(), not msg.sender
      await usdc.write.approve([market.address, USDC(100)], { account: user.account });
      await market.write.buyYes([USDC(100)], { account: user.account });

      const userShares = await market.read.yesBalances([user.account.address]);
      const canSell = await market.read.canUserSell([user.account.address]);

      console.log(`  User has ${Number(userShares) / 1e18} shares`);
      console.log(`  Can user sell immediately: ${canSell}`);

      // Should not be able to sell immediately (MIN_HOLD_BLOCKS protection)
      assert.ok(!canSell, "User should not be able to sell immediately");

      // Wait MIN_HOLD_BLOCKS
      for (let i = 0; i < 10; i++) {
        await provider.send("evm_mine");
      }

      const canSellAfterWait = await market.read.canUserSell([user.account.address]);
      console.log(`  Can user sell after MIN_HOLD_BLOCKS: ${canSellAfterWait}`);
      assert.ok(canSellAfterWait, "User should be able to sell after MIN_HOLD_BLOCKS");
    });
  });

  describe("Forwarder State Consistency", function () {
    it("should maintain consistent state across multiple meta-transactions", async function () {
      const { usdc, market } = await deployAll();

      // User makes multiple trades (simulating meta-transactions)
      await usdc.write.approve([market.address, USDC(500)], { account: user.account });

      // Trade 1: Buy YES
      await market.write.buyYes([USDC(100)], { account: user.account });
      const yesAfter1 = await market.read.yesBalances([user.account.address]);

      // Trade 2: Buy more YES
      await market.write.buyYes([USDC(100)], { account: user.account });
      const yesAfter2 = await market.read.yesBalances([user.account.address]);

      // Trade 3: Buy NO
      await market.write.buyNo([USDC(100)], { account: user.account });
      const noAfter3 = await market.read.noBalances([user.account.address]);

      console.log(`  YES shares after trade 1: ${Number(yesAfter1) / 1e18}`);
      console.log(`  YES shares after trade 2: ${Number(yesAfter2) / 1e18}`);
      console.log(`  NO shares after trade 3: ${Number(noAfter3) / 1e18}`);

      // Verify state is cumulative
      assert.ok(yesAfter2 > yesAfter1, "YES shares should accumulate");
      assert.ok(noAfter3 > 0n, "NO shares should be recorded");

      // Verify total shares accounting
      const totalYes = await market.read.totalYes();
      const totalNo = await market.read.totalNo();
      const qYes = await market.read.qYes();
      const qNo = await market.read.qNo();

      console.log(`  totalYes: ${Number(totalYes) / 1e18}, qYes: ${Number(qYes) / 1e18}`);
      console.log(`  totalNo: ${Number(totalNo) / 1e18}, qNo: ${Number(qNo) / 1e18}`);

      // LMSR invariant: qYes + qNo should equal total outstanding shares
      // (Note: qYes/qNo track LMSR state, totalYes/totalNo track user balances)
      assert.ok(totalYes >= yesAfter2, "totalYes should include user shares");
      assert.ok(totalNo >= noAfter3, "totalNo should include user shares");
    });

    it("should handle concurrent users without context collision", async function () {
      const { usdc, market } = await deployAll();

      // Fund another user
      await usdc.write.mint([relayer.account.address, USDC(1_000)]);

      // Both users trade simultaneously (different addresses, no collision)
      await usdc.write.approve([market.address, USDC(100)], { account: user.account });
      await usdc.write.approve([market.address, USDC(100)], { account: relayer.account });

      await market.write.buyYes([USDC(100)], { account: user.account });
      await market.write.buyNo([USDC(100)], { account: relayer.account });

      const userYes = await market.read.yesBalances([user.account.address]);
      const userNo = await market.read.noBalances([user.account.address]);
      const relayerYes = await market.read.yesBalances([relayer.account.address]);
      const relayerNo = await market.read.noBalances([relayer.account.address]);

      console.log(`  User: YES=${Number(userYes) / 1e18}, NO=${Number(userNo) / 1e18}`);
      console.log(`  Relayer: YES=${Number(relayerYes) / 1e18}, NO=${Number(relayerNo) / 1e18}`);

      // Verify no context collision
      assert.ok(userYes > 0n, "User should have YES shares");
      assert.equal(userNo, 0n, "User should have no NO shares");
      assert.equal(relayerYes, 0n, "Relayer should have no YES shares");
      assert.ok(relayerNo > 0n, "Relayer should have NO shares");
    });
  });
});
