// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TruthMarket is Ownable, ReentrancyGuard {
    IERC20 public immutable bettingToken;
    address public feeTreasury;
    uint256 public nextMarketId;

    struct Market {
        string question;
        string[] options;
        bool resolved;
        uint256 winningOptionIndex;
        bool voided;
        uint256 totalPool;
        uint256 bettingEndsAt;
        address creator;
        uint256 parentMarketId;
    }

    mapping(uint256 => Market) public markets;
    // marketId -> optionIndex -> amount
    mapping(uint256 => mapping(uint256 => uint256)) public marketOptionPools;
    // marketId -> user -> optionIndex -> amount
    mapping(uint256 => mapping(address => mapping(uint256 => uint256))) public userStakes;
    // marketId -> user -> claimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    // marketId -> payoutPool
    mapping(uint256 => uint256) public marketPayoutPools;

    event MarketCreated(uint256 indexed marketId, string question, string[] options, uint256 bettingEndsAt, uint256 parentMarketId);
    event BetPlaced(uint256 indexed marketId, address indexed user, uint256 optionIndex, uint256 wager, uint256 netStake);
    event MarketResolved(uint256 indexed marketId, uint256 winningOptionIndex, bool voided);
    event WinningsClaimed(uint256 indexed marketId, address indexed user, uint256 amount);
    event FeeTreasuryUpdated(address oldTreasury, address newTreasury);

    constructor(address _bettingToken, address _feeTreasury) Ownable(msg.sender) {
        bettingToken = IERC20(_bettingToken);
        feeTreasury = _feeTreasury;
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid address");
        emit FeeTreasuryUpdated(feeTreasury, newTreasury);
        feeTreasury = newTreasury;
    }

    function createMarket(string memory question, string[] memory options, uint256 duration, uint256 parentMarketId) external onlyOwner {
        _createMarket(question, options, duration, parentMarketId);
    }

    function createMarketBatch(
        string[] memory questions,
        string[][] memory options,
        uint256[] memory durations,
        uint256[] memory parentMarketIds
    ) external onlyOwner {
        require(questions.length == options.length, "Mismatched arrays");
        require(questions.length == durations.length, "Mismatched arrays");
        require(questions.length == parentMarketIds.length, "Mismatched arrays");

        for (uint256 i = 0; i < questions.length; i++) {
            _createMarket(questions[i], options[i], durations[i], parentMarketIds[i]);
        }
    }

    function _createMarket(string memory question, string[] memory options, uint256 duration, uint256 parentMarketId) internal {
        require(options.length > 1, "At least 2 options required");
        uint256 marketId = nextMarketId++;
        Market storage m = markets[marketId];
        m.question = question;
        m.options = options;
        m.bettingEndsAt = block.timestamp + duration;
        m.creator = msg.sender;
        m.parentMarketId = parentMarketId;
        emit MarketCreated(marketId, question, options, m.bettingEndsAt, parentMarketId);
    }

    function getMarketOptions(uint256 marketId) external view returns (string[] memory) {
        require(marketId < nextMarketId, "Market does not exist");
        return markets[marketId].options;
    }

    function placeBet(uint256 marketId, uint256 optionIndex, uint256 amount) external nonReentrant {
        require(marketId < nextMarketId, "Market does not exist");
        Market storage m = markets[marketId];
        require(!m.resolved, "Market resolved");
        require(block.timestamp < m.bettingEndsAt, "Betting closed");
        require(optionIndex < m.options.length, "Invalid option");
        require(amount > 0, "Amount must be > 0");

        bettingToken.transferFrom(msg.sender, address(this), amount);

        // 1.5% Entry Rake
        uint256 entryRake = (amount * 15) / 1000;
        uint256 netStake = amount - entryRake;

        if (entryRake > 0) {
            bettingToken.transfer(feeTreasury, entryRake);
        }

        m.totalPool += netStake;
        marketOptionPools[marketId][optionIndex] += netStake;
        userStakes[marketId][msg.sender][optionIndex] += netStake;

        emit BetPlaced(marketId, msg.sender, optionIndex, amount, netStake);
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

        bool voided = (losingPool == 0) || (winningPool == 0);
        m.voided = voided;

        if (!voided) {
            // 5% Resolution Rake on Profit (Losing Pool)
            uint256 resolutionRake = (losingPool * 5) / 100;
            if (resolutionRake > 0) {
                bettingToken.transfer(feeTreasury, resolutionRake);
            }

            // The payout pool is the total pool minus the resolution rake
            marketPayoutPools[marketId] = totalPool - resolutionRake;
        }

        emit MarketResolved(marketId, winningOptionIndex, voided);
    }

    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.resolved, "Not resolved");
        require(!hasClaimed[marketId][msg.sender], "Already claimed");

        uint256 payout = 0;

        if (m.voided) {
            // Refund all net stakes for this user in this market
            for (uint256 i = 0; i < m.options.length; i++) {
                payout += userStakes[marketId][msg.sender][i];
            }
        } else {
            // Standard Payout (Only for winning option)
            uint256 userStake = userStakes[marketId][msg.sender][m.winningOptionIndex];
            if (userStake > 0) {
                 uint256 winningPool = marketOptionPools[marketId][m.winningOptionIndex];
                 uint256 payoutPool = marketPayoutPools[marketId];

                 // Payout = userStake * (payoutPool / winningPool)
                 payout = (userStake * payoutPool) / winningPool;
            }
        }

        require(payout > 0, "Nothing to claim");

        hasClaimed[marketId][msg.sender] = true;
        bettingToken.transfer(msg.sender, payout);

        emit WinningsClaimed(marketId, msg.sender, payout);
    }
}