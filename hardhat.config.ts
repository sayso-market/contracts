import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import "dotenv/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1, // Low runs to minimize code size
      },
      viaIR: true, // Enable IR-based compiler for stack depth issues (LMSR)
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sei: {
      type: "http",
      chainType: "l1",
      url: "https://evm-rpc.sei-apis.com",
      accounts: process.env.DEPLOYER ? [process.env.DEPLOYER] : [],
      chainId: 1329,
    },
  },
});
