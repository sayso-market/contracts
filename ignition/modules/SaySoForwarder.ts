import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("Forwarder", (m) => {
  // Deploy SaySoForwarder (extends ERC2771Forwarder)
  const forwarder = m.contract("SaySoForwarder", []);
  
  return { forwarder };
});
