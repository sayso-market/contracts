import { network } from "hardhat";

async function main() {
  const { viem } = await network.connect();
  const pc = await viem.getPublicClient();

  const pool = "0x6e4Da59d1B4F6299e633383E3D41015d296DE98d" as `0x${string}`;
  const usdc = "0xc532b4689147e3d14e4f8819e8fec529b517ada9" as `0x${string}`;
  const userA = "0x54b1388bcc31De1De17D4715Cb047145162cDac9" as `0x${string}`;
  const userB = "0xAEead717A1C59ca1aD6aA5582bAfb0f8E91dd21f" as `0x${string}`;
  const forwarder = "0xf7f8009c48ffc7bb4bdf8bc44afe32a4201070a1" as `0x${string}`;

  const AMM_ABI = [
    { name: "effectiveFrom", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "effectiveTo", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "resolutionOpen", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "resolutionClose", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "feeCollector", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "liquidityParameter", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "totalDeposited", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "isTrustedForwarder", type: "function", stateMutability: "view", inputs: [{ name: "f", type: "address" }], outputs: [{ type: "bool" }] },
  ] as const;

  const ERC20_ABI = [
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  ] as const;

  const now = Math.floor(Date.now() / 1000);
  console.log("Current time:", now);

  const [effectiveFrom, effectiveTo, resOpen, resClose, feeCollector, token, poolName, liqParam, totalDep, trusted] = await Promise.all([
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "effectiveFrom" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "effectiveTo" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "resolutionOpen" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "resolutionClose" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "feeCollector" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "token" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "name" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "liquidityParameter" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "totalDeposited" }),
    pc.readContract({ address: pool, abi: AMM_ABI, functionName: "isTrustedForwarder", args: [forwarder] }),
  ]);

  console.log("\nPool:", pool);
  console.log("Name:", poolName);
  console.log("Token:", token);
  console.log("USDC contract:", usdc);
  console.log("Token matches USDC:", token.toLowerCase() === usdc.toLowerCase());
  console.log("Fee collector:", feeCollector);
  console.log("Liquidity param:", liqParam.toString());
  console.log("Total deposited:", totalDep.toString());
  console.log("Trusts forwarder:", trusted);

  console.log("\nTiming:");
  console.log("  effectiveFrom:", Number(effectiveFrom), new Date(Number(effectiveFrom) * 1000).toISOString());
  console.log("  effectiveTo:", Number(effectiveTo), new Date(Number(effectiveTo) * 1000).toISOString());
  console.log("  resOpen:", Number(resOpen), new Date(Number(resOpen) * 1000).toISOString());
  console.log("  resClose:", Number(resClose), new Date(Number(resClose) * 1000).toISOString());
  console.log("  In trading window:", now >= Number(effectiveFrom) && now <= Number(effectiveTo));

  const [aBalance, bBalance, aAllowance, bAllowance, poolBalance] = await Promise.all([
    pc.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [userA] }),
    pc.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [userB] }),
    pc.readContract({ address: usdc, abi: ERC20_ABI, functionName: "allowance", args: [userA, pool] }),
    pc.readContract({ address: usdc, abi: ERC20_ABI, functionName: "allowance", args: [userB, pool] }),
    pc.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [pool] }),
  ]);

  console.log("\nUser A USDC balance:", aBalance.toString());
  console.log("User B USDC balance:", bBalance.toString());
  console.log("User A allowance to pool:", aAllowance.toString());
  console.log("User B allowance to pool:", bAllowance.toString());
  console.log("Pool USDC balance:", poolBalance.toString());

  // Estimate gas for buyYes via the forwarder
  const BUY_YES_ABI = [
    { name: "buyYes", type: "function", stateMutability: "nonpayable", inputs: [{ name: "maxCost", type: "uint256" }], outputs: [] },
  ] as const;
  const { encodeFunctionData } = await import("viem");
  const data = encodeFunctionData({ abi: BUY_YES_ABI, functionName: "buyYes", args: [50000000n] });

  // Estimate gas for a direct call (simulate as pool calling itself for gas estimation)
  try {
    const gasEstimate = await pc.estimateGas({
      account: userA,
      to: pool,
      data: data as `0x${string}`,
    });
    console.log("\nEstimated gas for buyYes(50 USDC):", gasEstimate.toString());
  } catch (e: any) {
    console.log("\nGas estimate failed:", e.message?.slice(0, 300) || String(e).slice(0, 300));
  }
}

main().catch(console.error);
