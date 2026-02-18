import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, formatUnits } from "viem";

const USDC = (n: number) => parseUnits(String(n), 6);
const FEE_COLLECTOR = "0xd59C4C70c10D2AF0D5bcefd9c64fe150bcd1350a";

describe("Market Seeding", async function () {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, creator] = await viem.getWalletClients();

  async function getNow(): Promise<number> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  it("creates a market with initial seed liquidity (75% YES, 25% NO)", async function () {
    const now = await getNow();

    // Deploy infrastructure
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000", // factory set after
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);

    // Link oracle to factory
    await oracle.write.setFactory([factory.address]);

    // Fund the creator with USDC
    await usdc.write.mint([creator.account.address, USDC(10000)]);
    assert.equal(await usdc.read.balanceOf([creator.account.address]), USDC(10000));

    // Calculate seed amounts: 10 USDC total, 75% YES (7.5 USDC), 25% NO (2.5 USDC)
    const totalSeed = USDC(10);
    const yesAmount = USDC(7.5);
    const noAmount = USDC(2.5);

    // Creator approves factory to spend seed amount
    await usdc.write.approve([factory.address, totalSeed], { account: creator.account });

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Create market with initial seed liquidity
    await factory.write.createMarket([
      "Will BTC hit $200k?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      yesAmount,
      noAmount,
    ], { account: creator.account });

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify creator's USDC was transferred
    const creatorBalance = await usdc.read.balanceOf([creator.account.address]);
    assert.equal(creatorBalance, USDC(9990)); // 10000 - 10 seed

    // Verify pool received the full seed amount (no fees on seeding)
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, totalSeed); // Full 10 USDC

    // Verify price reflects YES-heavy seeding (LMSR gives ~59% for 75/25 split)
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent > 50 && pricePercent < 70, `Price ${pricePercent}% should be > 50% (YES-heavy)`);

    // Verify qYes and qNo are amplified (virtual liquidity for LMSR pricing)
    const info = await market.read.getMarketInfo();
    const yesAmount18 = yesAmount * 1000000000000n; // Scale 6 decimals to 18
    const noAmount18 = noAmount * 1000000000000n;
    const amplifier = 15n; // b/totalSeed = 15x
    assert.equal(info[4], yesAmount18 * amplifier); // qYes amplified
    assert.equal(info[5], noAmount18 * amplifier); // qNo amplified

    // Verify creator received actual shares (not amplified)
    const creatorYesShares = await market.read.yesBalances([creator.account.address]);
    const creatorNoShares = await market.read.noBalances([creator.account.address]);
    assert.equal(creatorYesShares, yesAmount18); // Actual shares
    assert.equal(creatorNoShares, noAmount18); // Actual shares

    console.log(`\n✓ Market created with ${formatUnits(totalSeed, 6)} USDC seed`);
    console.log(`  YES: ${formatUnits(yesAmount, 6)} USDC (${pricePercent}%)`);
    console.log(`  NO:  ${formatUnits(noAmount, 6)} USDC (${100 - pricePercent}%)`);
    console.log(`  Pool balance: ${formatUnits(poolBalance, 6)} USDC (no fees charged)`);
  });

  it("creates a market with balanced liquidity (50% price)", async function () {
    const now = await getNow();

    // Deploy infrastructure
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000", // factory set after
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);

    // Link oracle to factory
    await oracle.write.setFactory([factory.address]);

    // Fund deployer with minimum seed (5 YES + 5 NO = 10 USDC)
    const seedAmount = USDC(10);
    await usdc.write.mint([deployer.account.address, seedAmount]);
    await usdc.write.approve([factory.address, seedAmount]);

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Create market with balanced seed (minimum 10 USDC: 5 YES + 5 NO)
    await factory.write.createMarket([
      "Will SOL flip ETH?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(5), // 5 USDC YES
      USDC(5), // 5 USDC NO
    ]);

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify price is ~50% (balanced)
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent >= 45 && pricePercent <= 55, `Price ${pricePercent}% should be near 50%`);

    console.log(`\n✓ Market created with balanced seed (${pricePercent.toFixed(2)}% price)`);
  });

  it("creates a market with initial seed liquidity (25% YES, 75% NO)", async function () {
    const now = await getNow();

    // Deploy infrastructure
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000", // factory set after
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);

    // Link oracle to factory
    await oracle.write.setFactory([factory.address]);

    // Fund the creator with USDC
    await usdc.write.mint([creator.account.address, USDC(10000)]);

    // Calculate seed amounts: 10 USDC total, 25% YES (2.5 USDC), 75% NO (7.5 USDC)
    const totalSeed = USDC(10);
    const yesAmount = USDC(2.5);
    const noAmount = USDC(7.5);

    // Creator approves factory to spend seed amount
    await usdc.write.approve([factory.address, totalSeed], { account: creator.account });

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Create market with initial seed liquidity
    await factory.write.createMarket([
      "Will ADA hit $100?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      yesAmount,
      noAmount,
    ], { account: creator.account });

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify creator's USDC was transferred
    const creatorBalance = await usdc.read.balanceOf([creator.account.address]);
    assert.equal(creatorBalance, USDC(9990)); // 10000 - 10 seed

    // Verify pool received the full seed amount (no fees on seeding)
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, totalSeed); // Full 10 USDC

    // Verify price reflects NO-heavy seeding (LMSR gives ~41% for 25/75 split)
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent > 30 && pricePercent < 50, `Price ${pricePercent}% should be < 50% (NO-heavy)`);

    // Verify qYes and qNo are amplified (virtual liquidity for LMSR pricing)
    const info = await market.read.getMarketInfo();
    const yesAmount18 = yesAmount * 1000000000000n; // Scale 6 decimals to 18
    const noAmount18 = noAmount * 1000000000000n;
    const amplifier = 15n; // b/totalSeed = 15x
    assert.equal(info[4], yesAmount18 * amplifier); // qYes amplified
    assert.equal(info[5], noAmount18 * amplifier); // qNo amplified

    // Verify creator received actual shares (not amplified)
    const creatorYesShares = await market.read.yesBalances([creator.account.address]);
    const creatorNoShares = await market.read.noBalances([creator.account.address]);
    assert.equal(creatorYesShares, yesAmount18); // Actual shares
    assert.equal(creatorNoShares, noAmount18); // Actual shares

    console.log(`\n✓ Market created with ${formatUnits(totalSeed, 6)} USDC seed`);
    console.log(`  YES: ${formatUnits(yesAmount, 6)} USDC (${pricePercent}%)`);
    console.log(`  NO:  ${formatUnits(noAmount, 6)} USDC (${100 - pricePercent}%)`);
    console.log(`  Pool balance: ${formatUnits(poolBalance, 6)} USDC (no fees charged)`);
  });

  it("creates a market with 100% YES seed", async function () {
    const now = await getNow();

    // Deploy infrastructure
    const usdc = await viem.deployContract("MockUSDC");
    const sayso = await viem.deployContract("SaySoToken");
    const forwarder = await viem.deployContract("SaySoForwarder");
    const oracle = await viem.deployContract("ResolutionOracle", [
      sayso.address,
      forwarder.address,
      "0x0000000000000000000000000000000000000000", // factory set after
    ]);
    const factory = await viem.deployContract("MarketFactory", [
      usdc.address,
      oracle.address,
      forwarder.address,
      FEE_COLLECTOR,
    ]);

    // Link oracle to factory
    await oracle.write.setFactory([factory.address]);

    // Fund the creator
    await usdc.write.mint([creator.account.address, USDC(100)]);

    // Approve factory
    await usdc.write.approve([factory.address, USDC(100)], { account: creator.account });

    const effectiveFrom = now;
    const effectiveTo = now + 200;
    const resolutionOpen = now + 300;
    const resolutionClose = now + 500;

    // Create market with 100% YES
    await factory.write.createMarket([
      "Will DOGE hit $10?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(100), // 100% YES
      0n,        // 0% NO
    ], { account: creator.account });

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify price is YES-biased (amplified q gives e^1/(e^1+e^0) ≈ 73.1% for 100/0)
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent > 65 && pricePercent < 80, `Price ${pricePercent}% should be 65-80% (100% YES seed with amplification)`);

    // Verify pool has full seed
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, USDC(100));

    console.log(`\n✓ Market created with 100% YES seed (price: ${pricePercent.toFixed(2)}%)`);
  });
});
