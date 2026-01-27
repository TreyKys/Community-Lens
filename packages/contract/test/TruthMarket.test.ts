import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("TruthMarket", function () {
  async function deployFixture() {
    const [owner, user1, user2, user3] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    const mockUSDCAddress = await mockUSDC.getAddress();

    const TruthMarket = await ethers.getContractFactory("TruthMarket");
    const truthMarket = await TruthMarket.deploy(mockUSDCAddress);
    const truthMarketAddress = await truthMarket.getAddress();

    // Mint tokens to users and approve
    const initialBalance = ethers.parseUnits("10000", 18);
    await mockUSDC.mint(user1.address, initialBalance);
    await mockUSDC.mint(user2.address, initialBalance);
    await mockUSDC.mint(user3.address, initialBalance);

    await mockUSDC.connect(user1).approve(truthMarketAddress, ethers.MaxUint256);
    await mockUSDC.connect(user2).approve(truthMarketAddress, ethers.MaxUint256);
    await mockUSDC.connect(user3).approve(truthMarketAddress, ethers.MaxUint256);

    return { truthMarket, mockUSDC, owner, user1, user2, user3 };
  }

  describe("Fee Logic", function () {
    it("Should deduct 5% fee on standard wins", async function () {
      const { truthMarket, mockUSDC, user1, user2 } = await loadFixture(deployFixture);

      await truthMarket.createMarket("Will it rain?", ["Yes", "No"], 3600);
      const marketId = 0;

      // User1 bets 100 on Yes
      const betAmount1 = ethers.parseUnits("100", 18);
      await truthMarket.connect(user1).placeBet(marketId, 0, betAmount1);

      // User2 bets 100 on No
      const betAmount2 = ethers.parseUnits("100", 18);
      await truthMarket.connect(user2).placeBet(marketId, 1, betAmount2);

      // Total Pool = 200. Fee = 10 (5% of 200). NetPot = 190.
      // Yes wins. WinningPool = 100.
      // 190 >= 100, so fee applies.
      // Payout = 100 * 190 / 100 = 190.

      await truthMarket.resolveMarket(marketId, 0); // Yes wins

      // Check balance before claim
      const balanceBefore = await mockUSDC.balanceOf(user1.address);

      await truthMarket.connect(user1).claim(marketId);

      const balanceAfter = await mockUSDC.balanceOf(user1.address);
      const profit = balanceAfter - balanceBefore;

      expect(profit).to.equal(ethers.parseUnits("190", 18));
    });

    it("Should WAIVE fee if Principal is at risk (No-Loss Guarantee)", async function () {
      const { truthMarket, mockUSDC, user1, user2 } = await loadFixture(deployFixture);

      await truthMarket.createMarket("Will it rain?", ["Yes", "No"], 3600);
      const marketId = 0;

      // User1 bets 1000 on Yes (Huge stake)
      const betAmount1 = ethers.parseUnits("1000", 18);
      await truthMarket.connect(user1).placeBet(marketId, 0, betAmount1);

      // User2 bets 10 on No (Tiny stake)
      const betAmount2 = ethers.parseUnits("10", 18);
      await truthMarket.connect(user2).placeBet(marketId, 1, betAmount2);

      // Total Pool = 1010.
      // Fee = 5% of 1010 = 50.5.
      // NetPot = 1010 - 50.5 = 959.5.
      // WinningPool (Principal) = 1000.
      // NetPot (959.5) < WinningPool (1000).
      // FEE SHOULD BE WAIVED. NetPot = 1010.

      await truthMarket.resolveMarket(marketId, 0); // Yes wins

      // Check events to verify fee waiver? Or just check payout.
      // Payout should be full share of 1010.
      // Since User1 owns 100% of winning pool: Payout = 1010.

      const balanceBefore = await mockUSDC.balanceOf(user1.address);
      await truthMarket.connect(user1).claim(marketId);
      const balanceAfter = await mockUSDC.balanceOf(user1.address);

      const payout = balanceAfter - balanceBefore;
      expect(payout).to.equal(ethers.parseUnits("1010", 18));
    });
  });

  describe("Void Logic", function () {
    it("Should refund 100% if losing side has 0 liquidity", async function () {
      const { truthMarket, mockUSDC, user1, user2 } = await loadFixture(deployFixture);

      await truthMarket.createMarket("Will it rain?", ["Yes", "No"], 3600);
      const marketId = 0;

      // Both bet on Yes
      const betAmount = ethers.parseUnits("100", 18);
      await truthMarket.connect(user1).placeBet(marketId, 0, betAmount);
      await truthMarket.connect(user2).placeBet(marketId, 0, betAmount);

      // No bets on No.
      // Resolve Yes wins. Losing side (No) has 0 liquidity.

      await truthMarket.resolveMarket(marketId, 0);

      const balanceBefore = await mockUSDC.balanceOf(user1.address);
      await truthMarket.connect(user1).claim(marketId);
      const balanceAfter = await mockUSDC.balanceOf(user1.address);

      // Refund principal
      expect(balanceAfter - balanceBefore).to.equal(betAmount);
    });

    it("Should refund 100% if winning side has 0 liquidity (No winners)", async function () {
      const { truthMarket, mockUSDC, user1 } = await loadFixture(deployFixture);

      await truthMarket.createMarket("Will it rain?", ["Yes", "No"], 3600);
      const marketId = 0;

      // User bets on No
      const betAmount = ethers.parseUnits("100", 18);
      await truthMarket.connect(user1).placeBet(marketId, 1, betAmount);

      // Yes wins. No one bet on Yes.
      await truthMarket.resolveMarket(marketId, 0);

      const balanceBefore = await mockUSDC.balanceOf(user1.address);
      await truthMarket.connect(user1).claim(marketId);
      const balanceAfter = await mockUSDC.balanceOf(user1.address);

      expect(balanceAfter - balanceBefore).to.equal(betAmount);
    });
  });

  describe("Batch Creation", function () {
    it("Should create multiple markets in batch", async function () {
      const { truthMarket } = await loadFixture(deployFixture);

      const questions = ["Q1", "Q2", "Q3"];
      const options = [["A", "B"], ["C", "D"], ["E", "F"]];
      const durations = [3600, 7200, 10800];

      await truthMarket.createMarketBatch(questions, options, durations);

      const m1 = await truthMarket.markets(0);
      const m2 = await truthMarket.markets(1);
      const m3 = await truthMarket.markets(2);

      expect(m1.question).to.equal("Q1");
      expect(m2.question).to.equal("Q2");
      expect(m3.question).to.equal("Q3");
    });

    it("Should revert if array lengths mismatch", async function () {
      const { truthMarket } = await loadFixture(deployFixture);

      const questions = ["Q1", "Q2"];
      const options = [["A", "B"]]; // Length 1
      const durations = [3600, 7200];

      await expect(
        truthMarket.createMarketBatch(questions, options, durations)
      ).to.be.revertedWith("Mismatched arrays");
    });
  });
});
