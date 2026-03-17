import { network, artifacts } from "hardhat";
import { getAddress } from "viem";
import fs from "fs";
import path from "path";

const DEPLOYMENTS_FILE = path.resolve(import.meta.dirname, "../deployments.json");

// Real USDC on Sei mainnet (Circle native)
const REAL_USDC = "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392" as const;

// SaySoToken already deployed — do not redeploy
const EXISTING_SAYSO_TOKEN = "0x2006Dfe910bF22D5019d25e71D66976827C7F237" as const;

async function main() {
  const { viem } = await network.connect();
  const walletClients = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  // Find the Ledger wallet client (configured via LEDGER_ADDRESS in hardhat.config)
  const ledgerAddress = process.env.LEDGER_ADDRESS?.toLowerCase();
  if (!ledgerAddress) {
    throw new Error("LEDGER_ADDRESS env var is required for prod deployment");
  }

  const deployer = walletClients.find(
    (wc) => wc.account.address.toLowerCase() === ledgerAddress
  );
  if (!deployer) {
    throw new Error(
      `Ledger wallet ${ledgerAddress} not found. Ensure your Ledger is connected and unlocked with the Ethereum app open.`
    );
  }

  console.log(`\n=== PRODUCTION DEPLOYMENT (Ledger) ===`);
  console.log(`Deployer: ${deployer.account.address}`);
  console.log(`USDC:     ${REAL_USDC} (native Circle USDC)`);
  const balance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`Balance:  ${Number(balance) / 1e18} SEI\n`);

  const gas = 10_000_000n;
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Fetch gas fees (Ledger requires explicit gas pricing)
  async function getGasFees() {
    const gasPrice = await publicClient.getGasPrice();
    return { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice / 10n };
  }

  // Helper: deploy a contract using the Ledger wallet client directly
  async function deployWithLedger(contractName: string, args: any[] = []) {
    const artifact = await artifacts.readArtifact(contractName);
    const fees = await getGasFees();
    const hash = await deployer.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode as `0x${string}`,
      args,
      gas,
      ...fees,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) {
      throw new Error(`${contractName} deployment failed — no contract address in receipt`);
    }
    return getAddress(receipt.contractAddress);
  }

  // Helper: call a write function on a deployed contract via Ledger
  async function writeWithLedger(address: `0x${string}`, contractName: string, functionName: string, args: any[]) {
    const artifact = await artifacts.readArtifact(contractName);
    const fees = await getGasFees();
    const hash = await deployer.writeContract({
      address,
      abi: artifact.abi,
      functionName,
      args,
      gas,
      ...fees,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ── Phase 1: No-dependency contracts ──────────────────
  // Note: NO MockUSDC — prod uses real USDC
  // Note: SaySoToken is already deployed and persistent — not redeployed
  const saysoTokenAddr = EXISTING_SAYSO_TOKEN;
  console.log("── Phase 1: Deploying independent contracts ──\n");
  console.log("  (Approve each transaction on your Ledger device)\n");
  console.log(`  SaySoToken      ${saysoTokenAddr} (existing — not redeployed)`);

  const forwarderAddr = await deployWithLedger("SaySoForwarder");
  console.log(`  SaySoForwarder  ${forwarderAddr}`);
  await delay(3000);

  // ── Phase 2: ResolutionOracle (needs SaySoToken, Forwarder) ──
  console.log("\n── Phase 2: Deploying ResolutionOracle ──\n");

  const oracleAddr = await deployWithLedger("ResolutionOracle", [
    saysoTokenAddr,
    forwarderAddr,
    "0x0000000000000000000000000000000000000000", // factory set after deployment
  ]);
  console.log(`  ResolutionOracle ${oracleAddr}`);

  // ── Phase 3: MarketFactory (uses real USDC) ──────────
  console.log("\n── Phase 3: Deploying MarketFactory ──\n");

  const factoryAddr = await deployWithLedger("MarketFactory", [
    REAL_USDC,
    oracleAddr,
    forwarderAddr,
    deployer.account.address, // fee collector = Ledger owner
  ]);
  console.log(`  MarketFactory    ${factoryAddr}`);

  // ── Phase 4: Wire up circular dependency ───────────────
  console.log("\n── Phase 4: Setting factory on oracle ──\n");

  const setFactoryHash = await writeWithLedger(oracleAddr as `0x${string}`, "ResolutionOracle", "setFactory", [factoryAddr]);
  console.log(`  Oracle.setFactory(${factoryAddr}) ✓ (tx: ${setFactoryHash})`);

  // ── Write deployments.json (prod key) ────────────────
  const deploymentsFile = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf-8"));
  deploymentsFile.prod = {
    network: "sei-mainnet",
    chainId: 1329,
    deployer: deployer.account.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      USDC: {
        address: REAL_USDC,
        note: "Native Circle USDC on Sei (not deployed by us)",
      },
      SaySoToken: {
        address: saysoTokenAddr,
        note: "Governance token (persistent — not redeployed)",
      },
      SaySoForwarder: {
        address: forwarderAddr,
        note: "ERC-2771 trusted forwarder for gasless meta-transactions",
      },
      ResolutionOracle: {
        address: oracleAddr,
        votingToken: saysoTokenAddr,
        trustedForwarder: forwarderAddr,
        factory: factoryAddr,
        note: "Voting = staking with ERC-2771 gasless support, per-pool, during resolution window",
      },
      MarketFactory: {
        address: factoryAddr,
        tradingToken: REAL_USDC,
        oracle: oracleAddr,
        trustedForwarder: forwarderAddr,
        feeCollector: deployer.account.address,
        note: "Permissionless market creation with LMSR pricing, 0.5% protocol fee",
      },
    },
  };

  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deploymentsFile, null, 2) + "\n");
  console.log("\n── deployments.json updated (prod) ──\n");

  const endBalance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`Gas spent: ${Number(balance - endBalance) / 1e18} SEI`);
  console.log(`Remaining: ${Number(endBalance) / 1e18} SEI\n`);

  console.log("=== NEXT STEPS ===");
  console.log("1. Fund the prod relayer wallet with SEI (gas), USDC (market seeding), and SAY (auto-voting)");
  console.log("2. Update prod API .env with the contract addresses above");
  console.log("3. Set WALLET env var to the prod relayer private key\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
