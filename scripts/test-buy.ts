import { network } from "hardhat";
import { encodeFunctionData, parseAbi } from "viem";

/**
 * Tests buyNo via forwarder on an existing pool
 */
async function main() {
  const { viem } = await network.connect();
  const pc = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const usdc = "0xc532b4689147e3d14e4f8819e8fec529b517ada9" as `0x${string}`;
  const forwarder = "0xf7f8009c48ffc7bb4bdf8bc44afe32a4201070a1" as `0x${string}`;
  const poolAddress = "0xad7cbbb51636ad0775d120a59c1ec7711d1879cf" as `0x${string}`;
  const gas = 10_000_000n;

  // Check pool timing
  const effectiveTo = await pc.readContract({
    address: poolAddress,
    abi: parseAbi(["function effectiveTo() view returns (uint256)"]),
    functionName: "effectiveTo",
  });
  const now = Math.floor(Date.now() / 1000);
  console.log("Trading window closes:", Number(effectiveTo), "now:", now, "in window:", now <= Number(effectiveTo));

  // Step 5: Try buyNo through the FORWARDER
  console.log("\n5. Testing buyNo via FORWARDER...");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { signTypedData } = await import("viem/accounts");

  // Approve pool to spend deployer's USDC for another bet
  const approve2Hash = await deployer.writeContract({
    address: usdc,
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [poolAddress, 50_000_000n],
    gas,
  });
  await pc.waitForTransactionReceipt({ hash: approve2Hash });
  console.log("   Pool approved for 50 USDC.");

  // Get forwarder nonce for deployer
  const fwdNonce = await pc.readContract({
    address: forwarder,
    abi: parseAbi(["function nonces(address owner) view returns (uint256)"]),
    functionName: "nonces",
    args: [deployer.account.address],
  });
  console.log("   Forwarder nonce:", fwdNonce.toString());

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const buyNoData = encodeFunctionData({
    abi: parseAbi(["function buyNo(uint256 maxCost)"]),
    functionName: "buyNo",
    args: [50_000_000n],
  });

  // Sign ForwardRequest
  const account = privateKeyToAccount(process.env.WALLET as `0x${string}`);
  const signature = await account.signTypedData({
    domain: { name: "SaySoForwarder", version: "1", chainId: 1329, verifyingContract: forwarder },
    types: {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    },
    primaryType: "ForwardRequest",
    message: {
      from: deployer.account.address,
      to: poolAddress,
      value: 0n,
      gas: 5_000_000n,
      nonce: fwdNonce,
      deadline: deadline,
      data: buyNoData,
    },
  });
  console.log("   Signature:", signature.slice(0, 20) + "...");

  // Execute through forwarder
  try {
    const fwdHash = await deployer.writeContract({
      address: forwarder,
      abi: parseAbi(["function execute((address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) payable"]),
      functionName: "execute",
      args: [{
        from: deployer.account.address,
        to: poolAddress,
        value: 0n,
        gas: 5_000_000n,
        deadline: deadline,
        data: buyNoData,
        signature: signature,
      }],
      gas: 10_000_000n,
    });
    const fwdReceipt = await pc.waitForTransactionReceipt({ hash: fwdHash });
    console.log("   FORWARDER SUCCESS! Gas used:", fwdReceipt.gasUsed.toString());
    console.log("   Status:", fwdReceipt.status);
  } catch (e: any) {
    console.log("   FORWARDER FAILED:", e.message?.slice(0, 500) || String(e).slice(0, 500));
  }
}

main().catch(console.error);
