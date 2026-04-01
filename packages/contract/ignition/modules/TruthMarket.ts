import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MockUSDCModule from "./MockUSDC";

const TruthMarketModule = buildModule("TruthMarketModule", (m) => {
  const { mockUSDC } = m.useModule(MockUSDCModule);

  // Use a placeholder for the feeTreasury and oracle for now.
  // We can just use the deployer account as a placeholder.
  const deployer = m.getAccount(0);

  // Constructor args: [bettingToken, feeTreasury, oracleAddress]
  const truthMarket = m.contract("TruthMarket", [mockUSDC, deployer, deployer]);
  return { truthMarket };
});

export default TruthMarketModule;
