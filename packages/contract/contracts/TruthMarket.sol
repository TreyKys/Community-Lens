// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TruthMarket is Ownable, ReentrancyGuard {
    IERC20 public immutable bettingToken;
    uint256 public nextMarketId;

    struct Market {
        string question;
        string[] options;
        bool resolved;
        uint256 winningOptionIndex;
        bool voided;
        uint256 totalPool;
    }

    mapping(uint256 => Market) public markets;
    // marketId -> optionIndex -> amount
    mapping(uint256 => mapping(uint256 => uint256)) public marketOptionPools;
    // marketId -> user -> optionIndex -> amount
    mapping(uint256 => mapping(address => mapping(uint256 => uint256))) public userStakes;
    // marketId -> user -> claimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event MarketCreated(uint256 indexed marketId, string question, string[] options);
    event BetPlaced(uint256 indexed marketId, address indexed user, uint256 optionIndex, uint256 amount);
    event MarketResolved(uint256 indexed marketId, uint256 winningOptionIndex, bool voided, bool feeWaived);
    event WinningsClaimed(uint256 indexed marketId, address indexed user, uint256 amount);

    constructor(address _bettingToken) Ownable(msg.sender) {
        bettingToken = IERC20(_bettingToken);
    }

    function createMarket(string memory question, string[] memory options) external onlyOwner {
        require(options.length > 1, "At least 2 options required");
        uint256 marketId = nextMarketId++;
        Market storage m = markets[marketId];
        m.question = question;
        m.options = options;
        emit MarketCreated(marketId, question, options);
    }

    function placeBet(uint256 marketId, uint256 optionIndex, uint256 amount) external nonReentrant {
        require(marketId < nextMarketId, "Market does not exist");
        Market storage m = markets[marketId];
        require(!m.resolved, "Market resolved");
        require(optionIndex < m.options.length, "Invalid option");
        require(amount > 0, "Amount must be > 0");

        bettingToken.transferFrom(msg.sender, address(this), amount);

        m.totalPool += amount;
        marketOptionPools[marketId][optionIndex] += amount;
        userStakes[marketId][msg.sender][optionIndex] += amount;

        emit BetPlaced(marketId, msg.sender, optionIndex, amount);
    }

    function resolveMarket(uint256 marketId, uint256 winningOptionIndex) external onlyOwner {
        Market storage m = markets[marketId];
        require(!m.resolved, "Already resolved");
        require(winningOptionIndex < m.options.length, "Invalid option");

        m.resolved = true;
        m.winningOptionIndex = winningOptionIndex;

        uint256 totalPool = m.totalPool;
        uint256 winningPool = marketOptionPools[marketId][winningOptionIndex];
        uint256 losingPool = totalPool - winningPool;

        // Void Rule: 0 liquidity on losing side -> Refund
        // Or 0 liquidity on winning side (no winners) -> Refund
        bool voided = (losingPool == 0) || (winningPool == 0);
        m.voided = voided;

        bool feeWaived = false;

        if (!voided) {
             uint256 fee = (totalPool * 5) / 100;
             uint256 netPot = totalPool - fee;

             // No-Loss Guarantee: If NetPot < Principal (WinningPool), waive fee
             if (netPot < winningPool) {
                 feeWaived = true;
             }
        }

        emit MarketResolved(marketId, winningOptionIndex, voided, feeWaived);
    }

    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.resolved, "Not resolved");
        require(!hasClaimed[marketId][msg.sender], "Already claimed");

        uint256 payout = 0;

        if (m.voided) {
            // Refund all stakes for this user in this market
            for (uint256 i = 0; i < m.options.length; i++) {
                payout += userStakes[marketId][msg.sender][i];
            }
        } else {
            // Standard Payout (Only for winning option)
            uint256 userStake = userStakes[marketId][msg.sender][m.winningOptionIndex];
            if (userStake > 0) {
                 uint256 totalPool = m.totalPool;
                 uint256 winningPool = marketOptionPools[marketId][m.winningOptionIndex];

                 uint256 fee = (totalPool * 5) / 100;
                 uint256 netPot = totalPool - fee;

                 // No-Loss Guarantee Check
                 if (netPot < winningPool) {
                     netPot = totalPool; // Fee waived
                 }

                 // Payout = userStake * (netPot / winningPool)
                 payout = (userStake * netPot) / winningPool;
            }
        }

        require(payout > 0, "Nothing to claim");

        hasClaimed[marketId][msg.sender] = true;
        bettingToken.transfer(msg.sender, payout);

        emit WinningsClaimed(marketId, msg.sender, payout);
    }
}
