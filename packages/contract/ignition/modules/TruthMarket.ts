import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MockUSDCModule from "./MockUSDC";

const TruthMarketModule = buildModule("TruthMarketModule", (m) => {
  const { mockUSDC } = m.useModule(MockUSDCModule);
  // Using a placeholder address for feeTreasury and oracleAddress as requested
  const feeTreasury = m.getAccount(1);
  const oracleAddress = feeTreasury; // placeholder

  const truthMarket = m.contract("TruthMarket", [mockUSDC, feeTreasury, oracleAddress]);
  return { truthMarket };
});

export default TruthMarketModule;
