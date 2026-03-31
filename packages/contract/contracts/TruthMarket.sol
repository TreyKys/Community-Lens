// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TruthMarket — Vault Pattern
/// @notice Off-chain bets, on-chain commitments.
///         Individual bets are recorded in Supabase and committed
///         as a Merkle root at market lock time. Resolution distributes
///         via the backend. The escape hatch protects users if the
///         backend ever goes silent for 30 days.
contract TruthMarket is Ownable, ReentrancyGuard {
    IERC20 public immutable bettingToken;
    address public feeTreasury;
    address public oracleAddress;

    // ── Market State ─────────────────────────────────────────────────
    struct Market {
        string question;
        string[] options;
        bool resolved;
        uint256 winningOptionIndex;
        bool voided;
        uint256 bettingEndsAt;
        address creator;
        uint256 parentMarketId;
        bytes32 merkleRoot;       // committed at lock time
        bool betStateLocked;      // true once commitBetState is called
    }

    uint256 public nextMarketId;
    mapping(uint256 => Market) public markets;

    // ── Escape Hatch ─────────────────────────────────────────────────
    uint256 public lastHeartbeat;
    uint256 public constant HEARTBEAT_TIMEOUT = 30 days;

    // Tracks balances for emergency withdrawal
    // Updated by the backend when crediting winnings
    mapping(address => uint256) public escrowBalances;

    // Prevent double emergency withdrawals
    mapping(address => bool) public hasEmergencyWithdrawn;

    // ── Events ───────────────────────────────────────────────────────
    event MarketCreated(uint256 indexed marketId, string question, string[] options, uint256 bettingEndsAt, uint256 parentMarketId);
    event BetStateCommitted(uint256 indexed marketId, bytes32 merkleRoot);
    event MarketResolved(uint256 indexed marketId, uint256 winningOptionIndex, bool voided);
    event HeartbeatFired(uint256 timestamp);
    event EmergencyWithdrawal(address indexed user, uint256 amount);
    event FeeTreasuryUpdated(address oldTreasury, address newTreasury);
    event OracleUpdated(address oldOracle, address newOracle);
    event EscrowBalanceUpdated(address indexed user, uint256 newBalance);

    constructor(address _bettingToken, address _feeTreasury, address _oracle) Ownable(msg.sender) {
        bettingToken = IERC20(_bettingToken);
        feeTreasury = _feeTreasury;
        oracleAddress = _oracle;
        lastHeartbeat = block.timestamp;
    }

    modifier onlyOracle() {
        require(msg.sender == oracleAddress || msg.sender == owner(), "Not oracle");
        _;
    }

    // ── Admin Config ─────────────────────────────────────────────────

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid address");
        emit FeeTreasuryUpdated(feeTreasury, newTreasury);
        feeTreasury = newTreasury;
    }

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Invalid address");
        emit OracleUpdated(oracleAddress, newOracle);
        oracleAddress = newOracle;
    }

    // ── Market Creation (preserved for non-sports markets) ────────────

    function createMarket(
        string memory question,
        string[] memory options,
        uint256 duration,
        uint256 parentMarketId
    ) external onlyOwner {
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

    function _createMarket(
        string memory question,
        string[] memory options,
        uint256 duration,
        uint256 parentMarketId
    ) internal {
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

    // ── Vault Functions ───────────────────────────────────────────────

    /// @notice Called by the backend at exact market lock time (kickoff / Pulse deadline).
    ///         Commits the final bet book as an immutable Merkle root.
    ///         Once called, the bet state cannot be altered without detection.
    function commitBetState(uint256 marketId, bytes32 merkleRoot) external onlyOwner {
        require(marketId < nextMarketId, "Market does not exist");
        Market storage m = markets[marketId];
        require(!m.betStateLocked, "Bet state already committed");
        require(!m.resolved, "Market already resolved");

        m.merkleRoot = merkleRoot;
        m.betStateLocked = true;

        emit BetStateCommitted(marketId, merkleRoot);
    }

    /// @notice Called by the oracle after the real-world result is known.
    ///         Backend handles individual payouts via Supabase balance updates.
    function resolveMarket(uint256 marketId, uint256 winningOptionIndex) external onlyOracle {
        Market storage m = markets[marketId];
        require(m.betStateLocked, "Bet state not yet committed");
        require(!m.resolved, "Already resolved");
        require(winningOptionIndex < m.options.length, "Invalid option");

        m.resolved = true;
        m.winningOptionIndex = winningOptionIndex;

        emit MarketResolved(marketId, winningOptionIndex, false);
    }

    /// @notice Backend calls this to update on-chain escrow balances for
    ///         users who have won. These balances are only used in emergencyWithdraw.
    function updateEscrowBalance(address user, uint256 newBalance) external onlyOwner {
        escrowBalances[user] = newBalance;
        emit EscrowBalanceUpdated(user, newBalance);
    }

    // ── Heartbeat & Escape Hatch ──────────────────────────────────────

    /// @notice Called weekly by the backend Inngest job.
    ///         Resets the 30-day emergency clock.
    function heartbeat() external onlyOwner {
        lastHeartbeat = block.timestamp;
        emit HeartbeatFired(block.timestamp);
    }

    /// @notice Anyone can call this if the backend has been silent for 30 days.
    ///         Pays out the user's registered escrow balance directly from the contract,
    ///         bypassing TruthMarket entirely.
    function emergencyWithdraw() external nonReentrant {
        require(
            block.timestamp > lastHeartbeat + HEARTBEAT_TIMEOUT,
            unicode"Heartbeat active — platform is running"
        );
        require(!hasEmergencyWithdrawn[msg.sender], "Already withdrawn");
        require(escrowBalances[msg.sender] > 0, "No balance to withdraw");

        uint256 amount = escrowBalances[msg.sender];
        escrowBalances[msg.sender] = 0;
        hasEmergencyWithdrawn[msg.sender] = true;

        require(bettingToken.transfer(msg.sender, amount), "Transfer failed");

        emit EmergencyWithdrawal(msg.sender, amount);
    }

    /// @notice Returns seconds remaining until emergency withdrawal unlocks.
    ///         Returns 0 if already unlocked.
    function emergencyUnlocksIn() external view returns (uint256) {
        uint256 unlockTime = lastHeartbeat + HEARTBEAT_TIMEOUT;
        if (block.timestamp >= unlockTime) return 0;
        return unlockTime - block.timestamp;
    }
}
