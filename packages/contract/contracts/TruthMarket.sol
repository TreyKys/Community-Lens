// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract TruthMarket is Ownable {
    IERC20 public immutable bettingToken;
    uint256 public lastHeartbeat;

    struct MarketCommit {
        bytes32 merkleRoot;
        bool isResolved;
        uint256 totalPool;
    }

    // marketId -> MarketCommit
    mapping(string => MarketCommit) public marketCommits;
    // msg.sender -> marketId -> claimed
    mapping(address => mapping(string => bool)) public hasClaimedEmergency;

    event BetStateCommitted(string marketId, bytes32 merkleRoot);
    event MarketResolved(string marketId, string winningOutcome, uint256 payoutToMasterWallet);
    event Heartbeat(uint256 timestamp);
    event EmergencyWithdraw(address user, string marketId, uint256 amount);

    constructor(address _bettingToken) Ownable(msg.sender) {
        bettingToken = IERC20(_bettingToken);
        lastHeartbeat = block.timestamp;
    }

    /**
     * @dev Fired by a backend CRON job strictly at the market's closes_at timestamp.
     * Records the tamper-proof Merkle Root of the entire user_bets book for that market.
     */
    function commitBetState(string calldata marketId, bytes32 merkleRoot, uint256 totalPool) external onlyOwner {
        require(marketCommits[marketId].merkleRoot == bytes32(0), "Market already committed");

        marketCommits[marketId] = MarketCommit({
            merkleRoot: merkleRoot,
            isResolved: false,
            totalPool: totalPool
        });

        emit BetStateCommitted(marketId, merkleRoot);
    }

    /**
     * @dev Fired by the Oracle to unlock the pool back to the Master Wallet for backend distribution.
     */
    function resolveMarket(string calldata marketId, string calldata winningOutcome, uint256 distributionAmount) external onlyOwner {
        MarketCommit storage m = marketCommits[marketId];
        require(m.merkleRoot != bytes32(0), "Market not committed");
        require(!m.isResolved, "Market already resolved");

        m.isResolved = true;

        // Unlock funds to the master wallet for backend distribution
        bettingToken.transfer(owner(), distributionAmount);

        emit MarketResolved(marketId, winningOutcome, distributionAmount);
    }

    /**
     * @dev Fired weekly by the backend admin to prove the backend is alive.
     */
    function heartbeat() external onlyOwner {
        lastHeartbeat = block.timestamp;
        emit Heartbeat(lastHeartbeat);
    }

    /**
     * @dev The 30-Day Escape Hatch. If the heartbeat stops for 30 days, any user can call this with their Merkle proof
     * to withdraw directly, bypassing TruthMarket entirely.
     */
    function emergencyWithdraw(string calldata marketId, uint256 userBalance, bytes32[] calldata proof) external {
        require(block.timestamp > lastHeartbeat + 30 days, "System is still active");
        require(!hasClaimedEmergency[msg.sender][marketId], "Already claimed");

        MarketCommit memory m = marketCommits[marketId];
        require(m.merkleRoot != bytes32(0), "Market not committed");
        require(!m.isResolved, "Cannot escape a resolved market"); // If resolved, backend distributed it

        // Verify Merkle Proof
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, userBalance))));
        require(MerkleProof.verify(proof, m.merkleRoot, leaf), "Invalid Merkle proof");

        hasClaimedEmergency[msg.sender][marketId] = true;

        // Transfer escape funds
        bettingToken.transfer(msg.sender, userBalance);

        emit EmergencyWithdraw(msg.sender, marketId, userBalance);
    }
}
