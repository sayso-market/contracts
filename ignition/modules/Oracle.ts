import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import * as fs from "fs";

export default buildModule("OracleModule", (m) => {
  const deployedAddresses = JSON.parse(
    fs.readFileSync("deployments.json", "utf8")
  );
  // Use new SaySoToken for voting
  const votingTokenAddress = deployedAddresses.contracts.SaySoToken.address;
  const forwarderAddress = deployedAddresses.contracts.SaySoForwarder.address;
  const oracle = m.contract("ResolutionOracle", [votingTokenAddress, forwarderAddress]);
  return { oracle };
});
