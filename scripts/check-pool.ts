import hre from "hardhat";
import { formatUnits } from "viem";

async function main() {
  const poolAddress = (process.argv[2] || "0x8CBdF8bA3Cee0037c9d856aa669A79628Fd4b9a2") as `0x${string}`;

  const ammAbi = [
    {
      name: "totalYesTokens",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
    {
      name: "totalNoTokens",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
    {
      name: "price",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
    {
      name: "name",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "string" }],
    },
  ] as const;

  const client = await hre.viem.getPublicClient();

  const [totalYes, totalNo, price, name] = await Promise.all([
    client.readContract({ address: poolAddress, abi: ammAbi, functionName: "totalYesTokens" }),
    client.readContract({ address: poolAddress, abi: ammAbi, functionName: "totalNoTokens" }),
    client.readContract({ address: poolAddress, abi: ammAbi, functionName: "price" }),
    client.readContract({ address: poolAddress, abi: ammAbi, functionName: "name" }),
  ]);

  console.log(`\nPool: ${poolAddress}`);
  console.log(`Name: ${name}`);
  console.log(`Total YES tokens: ${formatUnits(totalYes, 6)} USDC`);
  console.log(`Total NO tokens: ${formatUnits(totalNo, 6)} USDC`);
  console.log(`Price: ${Number(price) / 1e16}% YES`);
  console.log(`Total liquidity: ${formatUnits(totalYes + totalNo, 6)} USDC`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
