import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("MockUSDCModule", (m) => {
  const token = m.contract("USDC");
  return { token };
});
