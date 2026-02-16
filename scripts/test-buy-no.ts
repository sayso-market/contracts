import { createPublicClient, createWalletClient, http, formatUnits, parseUnits } from 'viem';
import { sei } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const poolAddress = '0x8CBdF8bA3Cee0037c9d856aa669A79628Fd4b9a2' as `0x${string}`;
const usdcAddress = '0xad1e5b9cc88da1fb2319e38958edabcbf597ff0d' as `0x${string}`;

const account = privateKeyToAccount(process.env.PRIVATE_KEY! as `0x${string}`);
const publicClient = createPublicClient({ chain: sei, transport: http('https://evm-rpc.sei-apis.com') });
const walletClient = createWalletClient({ chain: sei, transport: http('https://evm-rpc.sei-apis.com'), account });

const ammAbi = [
  { name: 'totalYesTokens', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalNoTokens', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'buyNo', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

const usdcAbi = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

async function main() {
  console.log(`\nTesting buyNo on pool: ${poolAddress}`);
  console.log(`Account: ${account.address}\n`);

  // Check current state
  const [yes, no] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: ammAbi, functionName: 'totalYesTokens' }),
    publicClient.readContract({ address: poolAddress, abi: ammAbi, functionName: 'totalNoTokens' }),
  ]);
  console.log(`Before: YES=${formatUnits(yes, 6)}, NO=${formatUnits(no, 6)}`);

  // Approve
  const approveAmount = parseUnits('1', 6);
  const approveHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: 'approve',
    args: [poolAddress, approveAmount],
  });
  console.log(`\nApprove tx: ${approveHash}`);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log('Approve confirmed');

  // Buy NO
  const buyAmount = parseUnits('1', 6);
  try {
    const buyHash = await walletClient.writeContract({
      address: poolAddress,
      abi: ammAbi,
      functionName: 'buyNo',
      args: [buyAmount],
    });
    console.log(`\nbuyNo tx: ${buyHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    console.log(`buyNo confirmed: status=${receipt.status}`);
  } catch (error: any) {
    console.error(`\nbuyNo FAILED: ${error.message}`);
    if (error.cause) console.error(`Cause: ${JSON.stringify(error.cause, null, 2)}`);
  }

  // Check new state
  const [yesAfter, noAfter] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: ammAbi, functionName: 'totalYesTokens' }),
    publicClient.readContract({ address: poolAddress, abi: ammAbi, functionName: 'totalNoTokens' }),
  ]);
  console.log(`\nAfter: YES=${formatUnits(yesAfter, 6)}, NO=${formatUnits(noAfter, 6)}`);
}

main().catch(console.error);
