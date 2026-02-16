import { createPublicClient, http } from 'viem';
import { sei } from 'viem/chains';
import fs from 'fs';

async function main() {
  const publicClient = createPublicClient({
    chain: sei,
    transport: http('https://evm-rpc.sei-apis.com')
  });

  // Read deployments
  const deployments = JSON.parse(fs.readFileSync('deployments.json', 'utf-8'));
  const factoryAddress = deployments.contracts.MarketFactory.address as `0x${string}`;

  console.log('\n── Verifying MarketFactory Deployment ──\n');
  console.log(`Factory Address: ${factoryAddress}`);

  // Read factory ABI
  const factoryArtifact = JSON.parse(
    fs.readFileSync('artifacts/contracts/MarketFactory.sol/MarketFactory.json', 'utf-8')
  );

  // Check if contract exists
  const code = await publicClient.getBytecode({ address: factoryAddress });
  if (!code || code === '0x') {
    console.error('❌ Contract not found at address');
    process.exit(1);
  }
  console.log('✓ Contract bytecode exists');

  // Read contract state
  const tradingToken = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'tradingToken',
  });
  console.log(`✓ Trading token: ${tradingToken}`);

  const oracle = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'oracle',
  });
  console.log(`✓ Oracle: ${oracle}`);

  const trustedForwarder = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'trustedForwarder',
  });
  console.log(`✓ Trusted forwarder: ${trustedForwarder}`);

  const marketCount = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'getMarketCount',
  });
  console.log(`✓ Current market count: ${marketCount}`);

  // Verify addresses match deployments.json
  const expectedUsdc = deployments.contracts.MockUSDC.address.toLowerCase();
  const expectedOracle = deployments.contracts.ResolutionOracle.address.toLowerCase();
  const expectedForwarder = deployments.contracts.SaySoForwarder.address.toLowerCase();

  if (tradingToken.toLowerCase() !== expectedUsdc) {
    console.error(`❌ Trading token mismatch: expected ${expectedUsdc}, got ${tradingToken}`);
    process.exit(1);
  }

  if (oracle.toLowerCase() !== expectedOracle) {
    console.error(`❌ Oracle mismatch: expected ${expectedOracle}, got ${oracle}`);
    process.exit(1);
  }

  if (trustedForwarder.toLowerCase() !== expectedForwarder) {
    console.error(`❌ Forwarder mismatch: expected ${expectedForwarder}, got ${trustedForwarder}`);
    process.exit(1);
  }

  console.log('\n✅ MarketFactory deployment verified successfully!\n');
}

main().catch(console.error);
