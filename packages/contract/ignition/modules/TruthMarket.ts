import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MockUSDCModule from "./MockUSDC";

const TruthMarketModule = buildModule("TruthMarketModule", (m) => {
  const { mockUSDC } = m.useModule(MockUSDCModule);
  const truthMarket = m.contract("TruthMarket", [mockUSDC]);
  return { truthMarket };
});

export default TruthMarketModule;
