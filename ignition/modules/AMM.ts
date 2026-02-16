import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import * as fs from "fs";

export default buildModule("AMMModule", (m) => {
  const config = JSON.parse(fs.readFileSync(".new-pool-config.json", "utf8"));
  const ammPool = m.contract("AMM", [
    config.usdc,
    config.oracle,
    config.name,
    BigInt(config.effectiveFrom),
    BigInt(config.effectiveTo),
    BigInt(config.resolutionOpen),
    BigInt(config.resolutionClose),
  ]);
  return { ammPool };
});
