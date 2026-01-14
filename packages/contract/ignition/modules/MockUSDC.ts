import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const MockUSDCModule = buildModule("MockUSDCModule", (m) => {
  const mockUSDC = m.contract("MockUSDC");
  return { mockUSDC };
});

export default MockUSDCModule;
