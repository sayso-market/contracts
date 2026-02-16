import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("TokenModule", (m) => {
  const token = m.contract("SaySoToken");
  return { token };
});
