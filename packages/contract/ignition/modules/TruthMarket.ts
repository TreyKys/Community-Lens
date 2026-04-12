import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MockUSDCModule from "./MockUSDC";

const TruthMarketModule = buildModule("TruthMarketModule", (m) => {
  const { mockUSDC } = m.useModule(MockUSDCModule);
  const feeTreasury = m.getAccount(0); // Using deployer as feeTreasury and oracleAddress placeholder
  const truthMarket = m.contract("TruthMarket", [mockUSDC, feeTreasury, feeTreasury]);
  return { truthMarket };
});

export default TruthMarketModule;
