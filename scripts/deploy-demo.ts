import { network } from "hardhat";
import fs from "fs";
import path from "path";

const DEPLOYMENTS_FILE = path.resolve(import.meta.dirname, "../deployments.json");

async function main() {
  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log(`\n=== DEMO DEPLOYMENT ===`);
  console.log(`Deployer: ${deployer.account.address}`);
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`Balance:  ${Number(balance) / 1e18} SEI\n`);

  const gas = 10_000_000n;
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ── Phase 1: No-dependency contracts ──────────────────
  console.log("── Phase 1: Deploying independent contracts ──\n");

  const mockUsdc = await viem.deployContract("MockUSDC", [], { gas });
  console.log(`  MockUSDC       ${mockUsdc.address}`);
  await delay(3000);

  const saysoToken = await viem.deployContract("SaySoToken", [], { gas });
  console.log(`  SaySoToken      ${saysoToken.address}`);
  await delay(3000);

  const forwarder = await viem.deployContract("SaySoForwarder", [], { gas });
  console.log(`  SaySoForwarder  ${forwarder.address}`);
  await delay(3000);

  // ── Phase 2: ResolutionOracle (needs SaySoToken, Forwarder) ──
  console.log("\n── Phase 2: Deploying ResolutionOracle ──\n");

  const oracle = await viem.deployContract("ResolutionOracle", [
    saysoToken.address,
    forwarder.address,
    "0x0000000000000000000000000000000000000000", // factory set after deployment
  ], { gas });
  console.log(`  ResolutionOracle ${oracle.address}`);

  // ── Phase 3: MarketFactory (needs MockUSDC, Oracle, Forwarder, FeeCollector) ──
  console.log("\n── Phase 3: Deploying MarketFactory ──\n");

  const factory = await viem.deployContract("MarketFactory", [
    mockUsdc.address,
    oracle.address,
    forwarder.address,
    deployer.account.address, // fee collector = deployer
  ], { gas });
  console.log(`  MarketFactory    ${factory.address}`);

  // ── Phase 4: Wire up circular dependency ───────────────
  console.log("\n── Phase 4: Setting factory on oracle ──\n");

  await oracle.write.setFactory([factory.address]);
  console.log(`  Oracle.setFactory(${factory.address}) ✓`);

  // ── Write deployments.json (demo key) ────────────────
  const deploymentsFile = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf-8"));
  deploymentsFile.demo = {
    network: "sei-mainnet",
    chainId: 1329,
    deployer: deployer.account.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MockUSDC: {
        address: mockUsdc.address,
        note: "Mock USDC: name='USD Coin', EIP-712 version='2', decimals=6, open mint",
      },
      SaySoToken: {
        address: saysoToken.address,
        note: "Governance token, onlyOwner mint, 100M max supply",
      },
      SaySoForwarder: {
        address: forwarder.address,
        note: "ERC-2771 trusted forwarder for gasless meta-transactions",
      },
      ResolutionOracle: {
        address: oracle.address,
        votingToken: saysoToken.address,
        trustedForwarder: forwarder.address,
        factory: factory.address,
        note: "Voting = staking with ERC-2771 gasless support, per-pool, during resolution window",
      },
      MarketFactory: {
        address: factory.address,
        tradingToken: mockUsdc.address,
        oracle: oracle.address,
        trustedForwarder: forwarder.address,
        feeCollector: deployer.account.address,
        note: "Permissionless market creation with LMSR pricing, 0.5% protocol fee",
      },
    },
  };

  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deploymentsFile, null, 2) + "\n");
  console.log("\n── deployments.json updated (demo) ──\n");

  const endBalance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`Gas spent: ${Number(balance - endBalance) / 1e18} SEI`);
  console.log(`Remaining: ${Number(endBalance) / 1e18} SEI\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
