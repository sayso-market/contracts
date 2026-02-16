/**
 * Fund persistent voter accounts with SAYSO tokens.
 * Run: npx hardhat run scripts/fund-voters.ts --network sei
 *
 * Uses the deployer wallet (owner of SaySoToken) to mint 10,000 SAYSO
 * to each voter address. Idempotent — can run multiple times to top up.
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { sei } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const SAYSO_TOKEN = '0x24eF40d6AE92D65dE2A95555fC12Faf50c94B881' as `0x${string}`;

const MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const VOTERS = [
  { name: 'Voter A', address: '0xCBCBf3f4C536FC7445747F686f1c225Bb637c244' as `0x${string}` },
  { name: 'Voter B', address: '0xC3418dbED33AB668FD8Ec00ae29cbb769C4CD0EF' as `0x${string}` },
];

const MINT_AMOUNT = parseUnits('10000', 18); // 10,000 SAYSO each

async function main() {
  const privateKey = process.env.DEPLOYER as `0x${string}`;
  if (!privateKey) {
    throw new Error('DEPLOYER env var not set. Add it to .env or export it.');
  }

  const account = privateKeyToAccount(privateKey);
  const rpcUrl = process.env.RPC_URL || 'https://evm-rpc.sei-apis.com';

  const publicClient = createPublicClient({ chain: sei, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: sei, transport: http(rpcUrl), account });

  console.log(`Deployer: ${account.address}`);
  console.log(`SaySoToken: ${SAYSO_TOKEN}\n`);

  for (const voter of VOTERS) {
    const balanceBefore = await publicClient.readContract({
      address: SAYSO_TOKEN,
      abi: MINT_ABI,
      functionName: 'balanceOf',
      args: [voter.address],
    });

    console.log(`${voter.name} (${voter.address})`);
    console.log(`  Balance before: ${formatUnits(balanceBefore, 18)} SAYSO`);

    const hash = await walletClient.writeContract({
      address: SAYSO_TOKEN,
      abi: MINT_ABI,
      functionName: 'mint',
      args: [voter.address, MINT_AMOUNT],
    });

    console.log(`  Mint tx: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });

    const balanceAfter = await publicClient.readContract({
      address: SAYSO_TOKEN,
      abi: MINT_ABI,
      functionName: 'balanceOf',
      args: [voter.address],
    });

    console.log(`  Balance after: ${formatUnits(balanceAfter, 18)} SAYSO\n`);
  }

  console.log('Done! Voters funded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
