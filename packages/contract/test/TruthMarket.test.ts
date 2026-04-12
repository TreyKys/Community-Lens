import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("TruthMarket - Vault Settlement", function () {
  async function deployFixture() {
    const [owner, user1, user2, oracle, feeTreasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();

    const TruthMarket = await ethers.getContractFactory("TruthMarket");
    const truthMarket = await TruthMarket.deploy(
      await mockUSDC.getAddress(),
      feeTreasury.address,
      oracle.address
    );

    // Initial funding for the vault
    const depositAmount = ethers.parseUnits("100000", 18);
    await mockUSDC.mint(owner.address, depositAmount);
    await mockUSDC.connect(owner).approve(await truthMarket.getAddress(), depositAmount);

    // In actual system users fund via Paystack, vault just manages payouts.
    // For test we mock an initial vault balance
    await mockUSDC.connect(owner).transfer(await truthMarket.getAddress(), depositAmount);

    return { truthMarket, mockUSDC, owner, user1, user2, oracle, feeTreasury };
  }

  describe("Batch Creation", function () {
    it("Should create multiple markets in batch", async function () {
      const { truthMarket } = await loadFixture(deployFixture);

      const questions = ["Q1", "Q2", "Q3"];
      const options = [["A", "B"], ["C", "D"], ["E", "F"]];
      const durations = [3600, 7200, 10800];
      const parents = [0, 0, 0];

      await truthMarket.createMarketBatch(questions, options, durations, parents);

      const m1 = await truthMarket.markets(0);
      const m2 = await truthMarket.markets(1);
      const m3 = await truthMarket.markets(2);

      expect(m1.question).to.equal("Q1");
      expect(m2.question).to.equal("Q2");
      expect(m3.question).to.equal("Q3");
    });
  });

  describe("Settlement Logic", function () {
    it("Should commit bet state with merkle root", async function () {
      const { truthMarket } = await loadFixture(deployFixture);

      await truthMarket.createMarket("Will it rain?", ["Yes", "No"], 3600, 0);
      const marketId = 0;

      const dummyMerkleRoot = ethers.encodeBytes32String("dummyRoot");
      await truthMarket.commitBetState(marketId, dummyMerkleRoot);

      const m = await truthMarket.markets(marketId);
      expect(m.betStateLocked).to.be.true;
    });

    it("Should resolve market via Oracle", async function () {
      const { truthMarket, oracle } = await loadFixture(deployFixture);

      await truthMarket.createMarket("Will it rain?", ["Yes", "No"], 3600, 0);
      const marketId = 0;

      const dummyMerkleRoot = ethers.encodeBytes32String("dummyRoot");
      await truthMarket.commitBetState(marketId, dummyMerkleRoot);

      await truthMarket.connect(oracle).resolveMarket(marketId, 0);

      const m = await truthMarket.markets(marketId);
      expect(m.resolved).to.be.true;
      expect(m.winningOptionIndex).to.equal(0);
    });

    it("Should update escrow balances manually as vault owner", async function () {
      const { truthMarket, user1 } = await loadFixture(deployFixture);

      const balance = ethers.parseUnits("500", 18);
      await truthMarket.updateEscrowBalance(user1.address, balance);

      expect(await truthMarket.escrowBalances(user1.address)).to.equal(balance);
    });
  });

  describe("Emergency Mechanism", function () {
    it("Should handle heartbeat", async function () {
       const { truthMarket } = await loadFixture(deployFixture);
       await truthMarket.heartbeat();
       // If it doesn't revert, heartbeat works
       expect(true).to.be.true;
    });
  });
});
