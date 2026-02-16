import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("Factory", (m) => {
  // Get the deployed contract addresses from params
  const usdcAddress = m.getParameter("usdcAddress");
  const oracleAddress = m.getParameter("oracleAddress");
  const forwarderAddress = m.getParameter("forwarderAddress");
  
  const factory = m.contract("MarketFactory", [usdcAddress, oracleAddress, forwarderAddress]);
  
  return { factory };
});
