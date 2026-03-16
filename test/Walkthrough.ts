import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { formatUnits, parseUnits } from "viem";

// ── Helpers ──────────────────────────────────────────────

const USDC = (n: number) => parseUnits(String(n), 6);
const SAYSO = (n: number) => parseUnits(String(n), 18);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

function fmtUsdc(amount: bigint): string {
  return Number(formatUnits(amount, 6)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtSAYSO(amount: bigint): string {
  return Number(formatUnits(amount, 18)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(price: bigint): string {
  return ((Number(price) / 1e18) * 100).toFixed(2) + "%";
}

function fmtShares(shares: bigint): string {
  return shares.toLocaleString();
}

function log(msg: string) {
  console.log(msg);
}

function header(title: string) {
  log("");
  log(`── ${title} ${"─".repeat(Math.max(0, 50 - title.length))}`)
  log("");
}

// ── Test ─────────────────────────────────────────────────

describe("SaySo Walkthrough", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, charlie, dave] = await viem.getWalletClients();

  async function advanceTime(seconds: number | bigint) {
    const sec = typeof seconds === 'bigint' ? Number(seconds) : seconds;
    await provider.send("evm_increaseTime", [sec]);
    await provider.send("evm_mine");
  }

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  it("full lifecycle with 4 users: bet → vote → resolve → claim", async function () {

    // ────────────────────────────────────────────────────
    header("STEP 1: Deploy & Fund");
    // ────────────────────────────────────────────────────

    const now = await getNow();
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000", // factory set after
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address, oracle.address, forwarder.address, FEE_COLLECTOR,
    ]);

    // Link oracle to factory
    await oracle.write.setFactory([factory.address]);

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Fund deployer with seed USDC (minimum 10 USDC required)
    const seedAmount = USDC(10); // 5 YES + 5 NO
    await usdc.write.mint([deployer.account.address, seedAmount]);
    await usdc.write.approve([factory.address, seedAmount]);

    await factory.write.createMarket([
      "Will ETH hit $10k by end of 2026?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(5), // initialYesTokens (5 USDC)
      USDC(5), // initialNoTokens (5 USDC)
      "0x0000000000000000000000000000000000000000" as `0x${string}`, // voting mode
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    log(`  Contracts deployed:`);
    log(`    MockUSDC         ${usdc.address}`);
    log(`    SaySoToken        ${sayso.address}`);
    log(`    ResolutionOracle   ${oracle.address}`);
    log(`    MarketFactory      ${factory.address}`);
    log(``);
    log(`  Market created: "Will ETH hit $10k by end of 2026?"`);
    log(`    Address:  ${marketAddress}`);
    log(`    Trading:  0s → 200s`);
    log(`    Voting:   300s → 500s`);

    // Fund users
    await usdc.write.mint([alice.account.address, USDC(10000)]);
    await usdc.write.mint([bob.account.address, USDC(10000)]);
    await sayso.write.mint([charlie.account.address, SAYSO(1000)]);
    await sayso.write.mint([dave.account.address, SAYSO(1000)]);

    log(``);
    log(`  Initial balances:`);
    log(`    Alice    USDC: ${fmtUsdc(await usdc.read.balanceOf([alice.account.address]))}`);
    log(`    Bob      USDC: ${fmtUsdc(await usdc.read.balanceOf([bob.account.address]))}`);
    log(`    Charlie  SAYSO: ${fmtSAYSO(await sayso.read.balanceOf([charlie.account.address]))}`);
    log(`    Dave     SAYSO: ${fmtSAYSO(await sayso.read.balanceOf([dave.account.address]))}`);

    assert.equal(await usdc.read.balanceOf([alice.account.address]), USDC(10000));
    assert.equal(await usdc.read.balanceOf([bob.account.address]), USDC(10000));
    assert.equal(await sayso.read.balanceOf([charlie.account.address]), SAYSO(1000));
    assert.equal(await sayso.read.balanceOf([dave.account.address]), SAYSO(1000));

    // ────────────────────────────────────────────────────
    header("STEP 2: Place Bets");
    // ────────────────────────────────────────────────────

    await advanceTime(2); // ensure we're in the trading window

    // Alice bets 100 USDC on YES
    await usdc.write.approve([market.address, USDC(100)], { account: alice.account });
    await market.write.buyYes([USDC(100)], { account: alice.account });

    const aliceShares = await market.read.yesBalances([alice.account.address]);
    const priceAfterAlice = await market.read.price();
    const poolAfterAlice = await usdc.read.balanceOf([market.address]);

    log(`  → Alice bets 100 USDC on YES`);
    log(`    Fee deducted:    0.50 USDC (0.5%)`);
    log(`    Net to pool:     99.50 USDC`);
    log(`    Shares received: ${fmtShares(aliceShares)}`);
    log(`    Alice USDC:      ${fmtUsdc(await usdc.read.balanceOf([alice.account.address]))}`);
    log(`    Pool balance:    ${fmtUsdc(poolAfterAlice)}`);
    log(`    YES price:       ${fmtPct(priceAfterAlice)}`);

    assert.equal(await usdc.read.balanceOf([alice.account.address]), USDC(9900));
    assert.ok(aliceShares > 0n, "Alice should receive shares");
    assert.ok(priceAfterAlice > 600000000000000000n, "Price should be elevated after YES purchase");
    assert.equal(poolAfterAlice, USDC(10) + USDC(99.5)); // seed + Alice's net deposit

    log(``);

    // Bob bets 500 USDC on NO
    await usdc.write.approve([market.address, USDC(500)], { account: bob.account });
    await market.write.buyNo([USDC(500)], { account: bob.account });

    const bobShares = await market.read.noBalances([bob.account.address]);
    const priceAfterBob = await market.read.price();
    const poolAfterBob = await usdc.read.balanceOf([market.address]);

    log(`  → Bob bets 500 USDC on NO`);
    log(`    Fee deducted:    2.50 USDC (0.5%)`);
    log(`    Net to pool:     497.50 USDC`);
    log(`    Shares received: ${fmtShares(bobShares)}`);
    log(`    Bob USDC:        ${fmtUsdc(await usdc.read.balanceOf([bob.account.address]))}`);
    log(`    Pool balance:    ${fmtUsdc(poolAfterBob)}`);
    log(`    YES price:       ${fmtPct(priceAfterBob)}`);

    assert.equal(await usdc.read.balanceOf([bob.account.address]), USDC(9500));
    assert.ok(bobShares > 0n, "Bob should receive shares");
    assert.equal(poolAfterBob, USDC(10) + USDC(99.5) + USDC(497.5)); // seed + deposits
    // Price should be lower than after Alice, but still favor YES
    assert.ok(priceAfterBob < priceAfterAlice, "Price should decrease after NO purchase");

    // ────────────────────────────────────────────────────
    header("STEP 3: Vote on Resolution (stake = vote)");
    // ────────────────────────────────────────────────────

    const now3 = await getNow();
    await advanceTime(resolutionOpen - now3 + 1);

    log(`  Time advanced to resolution window`);
    log(``);

    // Charlie votes YES by staking 600 SAYSO on the pool
    await sayso.write.approve([oracle.address, SAYSO(600)], { account: charlie.account });
    await oracle.write.voteYes([marketAddress, SAYSO(600)], { account: charlie.account });

    log(`  → Charlie votes YES with 600 SAYSO (transferred to oracle)`);
    log(`    Charlie wallet:   ${fmtSAYSO(await sayso.read.balanceOf([charlie.account.address]))} SAYSO`);

    assert.equal(await sayso.read.balanceOf([charlie.account.address]), SAYSO(400));
    assert.equal(await oracle.read.yesVotesByUser([marketAddress, charlie.account.address]), SAYSO(600));

    // Dave votes NO by staking 400 SAYSO on the pool
    await sayso.write.approve([oracle.address, SAYSO(400)], { account: dave.account });
    await oracle.write.voteNo([marketAddress, SAYSO(400)], { account: dave.account });

    log(`  → Dave votes NO with 400 SAYSO (transferred to oracle)`);
    log(`    Dave wallet:      ${fmtSAYSO(await sayso.read.balanceOf([dave.account.address]))} SAYSO`);

    assert.equal(await sayso.read.balanceOf([dave.account.address]), SAYSO(600));
    assert.equal(await oracle.read.noVotesByUser([marketAddress, dave.account.address]), SAYSO(400));

    const totalYes = await oracle.read.yesVotesTotal([marketAddress]);
    const totalNo = await oracle.read.noVotesTotal([marketAddress]);
    log(``);
    log(`  Vote tally:`);
    log(`    YES: ${fmtSAYSO(totalYes)}  NO: ${fmtSAYSO(totalNo)}`);
    log(`    Result: YES is winning (${fmtPct(await oracle.read.getYesPercentage([marketAddress]))})`);

    assert.equal(totalYes, SAYSO(600));
    assert.equal(totalNo, SAYSO(400));

    // ────────────────────────────────────────────────────
    header("STEP 4: Resolve Market");
    // ────────────────────────────────────────────────────

    const now4 = await getNow();
    await advanceTime(resolutionClose - now4 + 1);

    await market.write.resolve();
    const [yesWins, isResolved] = await market.read.getOutcome();

    log(`  Time advanced past resolution close`);
    log(`  Market resolved!`);
    log(`    Outcome:  ${yesWins ? "YES wins" : "NO wins"}`);
    log(`    Pool:     ${fmtUsdc(await usdc.read.balanceOf([market.address]))} USDC to distribute`);

    assert.equal(isResolved, true);
    assert.equal(yesWins, true);

    // ────────────────────────────────────────────────────
    header("STEP 5: Claim USDC (Bettors)");
    // ────────────────────────────────────────────────────

    // Alice claims (winner)
    const aliceUsdcBefore = await usdc.read.balanceOf([alice.account.address]);
    await market.write.claim({ account: alice.account });
    const aliceUsdcAfter = await usdc.read.balanceOf([alice.account.address]);
    const alicePayout = aliceUsdcAfter - aliceUsdcBefore;

    log(`  → Alice claims (YES winner)`);
    log(`    Payout received:  ${fmtUsdc(alicePayout)} USDC`);
    log(`    Alice USDC now:   ${fmtUsdc(aliceUsdcAfter)}`);
    log(`    Net P&L:          +${fmtUsdc(aliceUsdcAfter - USDC(10000))} USDC`);

    // Alice is the only YES bettor → gets most of pool (seed + deposits = ~607 USDC)
    assert.ok(alicePayout >= USDC(580) && alicePayout <= USDC(620), "Alice should get ~600 USDC");
    assert.ok(aliceUsdcAfter >= USDC(10480) && aliceUsdcAfter <= USDC(10520), "Alice total should be ~10500");

    log(``);

    // Bob tries to claim (loser)
    const bobUsdcBefore = await usdc.read.balanceOf([bob.account.address]);
    let bobClaimReverted = false;
    try {
      await market.write.claim({ account: bob.account });
    } catch {
      bobClaimReverted = true;
    }

    log(`  → Bob claims (NO loser)`);
    log(`    Claim reverted:   ${bobClaimReverted ? "yes (no payout for losers)" : "no"}`);
    log(`    Bob USDC now:     ${fmtUsdc(await usdc.read.balanceOf([bob.account.address]))}`);
    log(`    Net P&L:          ${fmtUsdc(bobUsdcBefore - USDC(10000))} USDC`);

    assert.equal(bobClaimReverted, true);
    assert.equal(await usdc.read.balanceOf([bob.account.address]), USDC(9500)); // lost his 500 bet

    log(``);
    const poolAfterClaims = await usdc.read.balanceOf([market.address]);
    log(`  Pool balance after claims: ${fmtUsdc(poolAfterClaims)} USDC (unclaimed seed)`);
    // Pool has unclaimed seed shares from deployer (~26.5 USDC)
    assert.ok(poolAfterClaims >= 0n && poolAfterClaims <= USDC(30), "Pool should have small remaining balance");

    // ────────────────────────────────────────────────────
    header("STEP 6: Claim SAYSO (Voters)");
    // ────────────────────────────────────────────────────

    // Charlie claims (winning voter)
    const charlieSAYSOBefore = await sayso.read.balanceOf([charlie.account.address]);
    await oracle.write.claim([marketAddress], { account: charlie.account });
    const charlieSAYSOAfter = await sayso.read.balanceOf([charlie.account.address]);
    const charliePayout = charlieSAYSOAfter - charlieSAYSOBefore;

    log(`  → Charlie claims (YES voter — winner)`);
    log(`    Payout received:  ${fmtSAYSO(charliePayout)} SAYSO`);
    log(`    (his 600 back + Dave's 400 = 1,000)`);
    log(`    Charlie wallet:   ${fmtSAYSO(charlieSAYSOAfter)} SAYSO`);

    // Charlie voted 600, gets all 1000 (600 + 400 from Dave)
    assert.equal(charliePayout, SAYSO(1000));
    assert.equal(charlieSAYSOAfter, SAYSO(1400)); // 400 kept + 1000 payout

    log(``);

    // Dave claims (losing voter — slashed)
    const daveSAYSOBefore = await sayso.read.balanceOf([dave.account.address]);
    await oracle.write.claim([marketAddress], { account: dave.account });
    const daveSAYSOAfter = await sayso.read.balanceOf([dave.account.address]);

    log(`  → Dave claims (NO voter — loser, slashed)`);
    log(`    Payout received:  ${fmtSAYSO(daveSAYSOAfter - daveSAYSOBefore)} SAYSO`);
    log(`    Dave wallet:      ${fmtSAYSO(daveSAYSOAfter)} SAYSO`);

    assert.equal(daveSAYSOAfter - daveSAYSOBefore, 0n); // loser gets nothing
    assert.equal(daveSAYSOAfter, SAYSO(600)); // only the 600 he didn't vote with

    // ────────────────────────────────────────────────────
    header("FINAL SUMMARY");
    // ────────────────────────────────────────────────────

    const aliceFinal = await usdc.read.balanceOf([alice.account.address]);
    const bobFinal = await usdc.read.balanceOf([bob.account.address]);
    const charlieFinal = await sayso.read.balanceOf([charlie.account.address]);
    const daveFinal = await sayso.read.balanceOf([dave.account.address]);

    log(`  User       Asset    Start       End         P&L`);
    log(`  ─────────  ───────  ──────────  ──────────  ──────────`);
    log(`  Alice      USDC     10,000.00   ${fmtUsdc(aliceFinal).padStart(10)}  +${fmtUsdc(aliceFinal - USDC(10000))}`);
    log(`  Bob        USDC     10,000.00   ${fmtUsdc(bobFinal).padStart(10)}  -${fmtUsdc(USDC(10000) - bobFinal)}`);
    log(`  Charlie    SAYSO    1,000.00   ${fmtSAYSO(charlieFinal).padStart(10)}  +${fmtSAYSO(charlieFinal - SAYSO(1000))}`);
    log(`  Dave       SAYSO    1,000.00   ${fmtSAYSO(daveFinal).padStart(10)}  -${fmtSAYSO(SAYSO(1000) - daveFinal)}`);

    // With LMSR, exact values differ from old AMM, use tolerance
    assert.ok(aliceFinal >= USDC(10475) && aliceFinal <= USDC(10490), "Alice should gain ~480 USDC");
    assert.equal(bobFinal, USDC(9500));          // Bob lost his 500 bet
    assert.equal(charlieFinal, SAYSO(1400));    // Charlie won 400 SAYSO
    assert.equal(daveFinal, SAYSO(600));        // Dave lost 400 SAYSO
  });
});
