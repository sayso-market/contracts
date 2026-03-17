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

    // Calculate seed amounts: 10 USDC total, 75% YES target price
    const totalSeed = USDC(10);
    const targetPriceBps = 7500n; // 75%

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
      totalSeed,
      targetPriceBps,
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      creator.account.address,
    ], { account: creator.account });

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify creator's USDC was transferred
    const creatorBalance = await usdc.read.balanceOf([creator.account.address]);
    assert.equal(creatorBalance, USDC(9990)); // 10000 - 10 seed

    // Verify pool received the full seed amount (no fees on seeding)
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, totalSeed); // Full 10 USDC

    // Verify price reflects YES-heavy seeding (~75% target)
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent > 70 && pricePercent < 80, `Price ${pricePercent}% should be near 75% target`);

    // Verify creator received seed shares: yesShares = totalSeed * 7500 / 10000
    const creatorYesShares = await market.read.yesBalances([creator.account.address]);
    const creatorNoShares = await market.read.noBalances([creator.account.address]);
    const expectedYesShares = totalSeed * 1000000000000n * 7500n / 10000n;
    const expectedNoShares = totalSeed * 1000000000000n - expectedYesShares;
    assert.equal(creatorYesShares, expectedYesShares);
    assert.equal(creatorNoShares, expectedNoShares);

    console.log(`\n Market created with ${formatUnits(totalSeed, 6)} USDC seed`);
    console.log(`  Target price: 75%, Actual: ${pricePercent.toFixed(2)}%`);
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

    // Create market with balanced seed (minimum 10 USDC, 50% target)
    await factory.write.createMarket([
      "Will SOL flip ETH?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(10), // 10 USDC total seed
      5000n,     // 50% target price
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      deployer.account.address,
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

    // 10 USDC total, 25% YES target
    const totalSeed = USDC(10);
    const targetPriceBps = 2500n; // 25%

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
      totalSeed,
      targetPriceBps,
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      creator.account.address,
    ], { account: creator.account });

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify creator's USDC was transferred
    const creatorBalance = await usdc.read.balanceOf([creator.account.address]);
    assert.equal(creatorBalance, USDC(9990)); // 10000 - 10 seed

    // Verify pool received the full seed amount (no fees on seeding)
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, totalSeed); // Full 10 USDC

    // Verify price reflects 25% target
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent > 20 && pricePercent < 30, `Price ${pricePercent}% should be near 25% target`);

    // Verify creator received seed shares proportional to target price
    const creatorYesShares = await market.read.yesBalances([creator.account.address]);
    const creatorNoShares = await market.read.noBalances([creator.account.address]);
    const expectedYesShares = totalSeed * 1000000000000n * 2500n / 10000n;
    const expectedNoShares = totalSeed * 1000000000000n - expectedYesShares;
    assert.equal(creatorYesShares, expectedYesShares);
    assert.equal(creatorNoShares, expectedNoShares);

    console.log(`\n Market created with ${formatUnits(totalSeed, 6)} USDC seed`);
    console.log(`  Target price: 25%, Actual: ${pricePercent.toFixed(2)}%`);
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

    // Create market with 99% YES target
    await factory.write.createMarket([
      "Will DOGE hit $10?",
      BigInt(effectiveFrom),
      BigInt(effectiveTo),
      BigInt(resolutionOpen),
      BigInt(resolutionClose),
      USDC(100), // 100 USDC total
      9900n,     // 99% YES target
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      creator.account.address,
    ], { account: creator.account });

    const marketAddress = (await factory.read.getAllMarkets())[0];
    const market = await viem.getContractAt("AMM", marketAddress);

    // Verify price is near 99% target
    const price = await market.read.price();
    const pricePercent = (Number(price) / 1e18) * 100;
    assert(pricePercent > 95 && pricePercent < 100, `Price ${pricePercent}% should be near 99% target`);

    // Verify pool has full seed
    const poolBalance = await usdc.read.balanceOf([market.address]);
    assert.equal(poolBalance, USDC(100));

    console.log(`\n✓ Market created with 100% YES seed (price: ${pricePercent.toFixed(2)}%)`);
  });
});
