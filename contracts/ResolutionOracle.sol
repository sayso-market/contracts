// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./AMM.sol";

// Forward declaration to avoid circular dependency
interface IMarketFactory {
    function isMarket(address market) external view returns (bool);
}

contract ResolutionOracle is ERC2771Context, ReentrancyGuard, Ownable {
    ERC20 public votingToken;
    IMarketFactory public factory;

    // pool => user => SAYSO staked on YES
    mapping(address => mapping(address => uint256)) public yesVotesByUser;
    mapping(address => mapping(address => uint256)) public noVotesByUser;

    // pool => total SAYSO staked
    mapping(address => uint256) public yesVotesTotal;
    mapping(address => uint256) public noVotesTotal;

    // pool => list of voters
    mapping(address => address[]) public votingUsersByPool;
    mapping(address => mapping(address => bool)) public hasVoted;

    // pool => user => has claimed
    mapping(address => mapping(address => bool)) public hasClaimed;

    // Events
    event VoteCast(address indexed pool, address indexed voter, bool isYes, uint256 amount);
    event VotingClaimed(address indexed pool, address indexed voter, uint256 amount);
    event FactoryUpdated(address indexed oldFactory, address indexed newFactory);

    constructor(
        ERC20 _votingToken,
        address _trustedForwarder,
        IMarketFactory _factory
    ) ERC2771Context(_trustedForwarder) Ownable(msg.sender) {
        require(address(_votingToken) != address(0), "Voting token cannot be zero address");
        require(_trustedForwarder != address(0), "Forwarder cannot be zero address");
        // Note: factory can be address(0) initially (circular dependency, set via setFactory later)

        votingToken = _votingToken;
        factory = _factory;
    }

    // Set factory address (admin only) - for initial setup or migration
    function setFactory(IMarketFactory _factory) public onlyOwner {
        require(address(_factory) != address(0), "Factory cannot be zero address");
        address oldFactory = address(factory);
        factory = _factory;
        emit FactoryUpdated(oldFactory, address(_factory));
    }

    // Override context functions to resolve ERC2771Context + Ownable conflict
    function _msgSender()
        internal
        view
        override(Context, ERC2771Context)
        returns (address)
    {
        return ERC2771Context._msgSender();
    }

    function _msgData()
        internal
        view
        override(Context, ERC2771Context)
        returns (bytes calldata)
    {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(Context, ERC2771Context)
        returns (uint256)
    {
        return ERC2771Context._contextSuffixLength();
    }

    modifier validMarket(address pool) {
        require(factory.isMarket(pool), "Not a valid market");
        _;
    }

    modifier duringVotingPeriod(address pool) {
        uint256 votingOpensAt = AMM(pool).resolutionOpen();
        uint256 votingClosesAt = AMM(pool).resolutionClose();
        require(block.timestamp >= votingOpensAt, "Voting has not opened yet");
        require(block.timestamp <= votingClosesAt, "Voting has closed");
        _;
    }

    // Vote YES by staking SAYSO on a pool. Tokens are transferred to the oracle.
    function voteYes(address pool, uint256 amount)
        public
        validMarket(pool)
        duringVotingPeriod(pool)
        nonReentrant
    {
        require(amount > 0, "Amount must be greater than 0");
        votingToken.transferFrom(_msgSender(), address(this), amount);

        yesVotesByUser[pool][_msgSender()] += amount;
        yesVotesTotal[pool] += amount;
        recordVotingUser(pool, _msgSender());

        emit VoteCast(pool, _msgSender(), true, amount);
    }

    // Vote NO by staking SAYSO on a pool. Tokens are transferred to the oracle.
    function voteNo(address pool, uint256 amount)
        public
        validMarket(pool)
        duringVotingPeriod(pool)
        nonReentrant
    {
        require(amount > 0, "Amount must be greater than 0");
        votingToken.transferFrom(_msgSender(), address(this), amount);

        noVotesByUser[pool][_msgSender()] += amount;
        noVotesTotal[pool] += amount;
        recordVotingUser(pool, _msgSender());

        emit VoteCast(pool, _msgSender(), false, amount);
    }

    function getYesPercentage(address pool) public view returns (uint256) {
        uint256 yesVotes = yesVotesTotal[pool];
        uint256 noVotes = noVotesTotal[pool];
        if (yesVotes + noVotes == 0) {
            return 5e17; // 50% if no votes
        }
        return (yesVotes * 1e18) / (yesVotes + noVotes);
    }

    function getOutcome(address pool) public view returns (bool yesWins, bool hasVotes) {
        uint256 yesVotes = yesVotesTotal[pool];
        uint256 noVotes = noVotesTotal[pool];
        if (yesVotes == 0 && noVotes == 0) {
            return (false, false);
        }
        return (yesVotes > noVotes, true);
    }

    function recordVotingUser(address pool, address user) internal {
        if (!hasVoted[pool][user]) {
            hasVoted[pool][user] = true;
            votingUsersByPool[pool].push(user);
        }
    }

    function getVotingUsers(address pool) public view returns (address[] memory) {
        return votingUsersByPool[pool];
    }

    function getVotingUserCount(address pool) public view returns (uint256) {
        return votingUsersByPool[pool].length;
    }

    function calculateClaim(address pool, address user) public view returns (uint256) {
        if (hasClaimed[pool][user]) {
            return 0;
        }

        uint256 votingClosesAt = AMM(pool).resolutionClose();
        require(block.timestamp >= votingClosesAt, "Voting is still open");

        uint256 yesTotal = yesVotesTotal[pool];
        uint256 noTotal = noVotesTotal[pool];
        uint256 total = yesTotal + noTotal;

        if (total == 0) {
            return 0;
        }

        bool yesWins = yesTotal > noTotal;
        uint256 winningTotal = yesWins ? yesTotal : noTotal;

        if (winningTotal == 0) {
            return 0;
        }

        uint256 userWinningVotes = yesWins
            ? yesVotesByUser[pool][user]
            : noVotesByUser[pool][user];

        if (userWinningVotes == 0) {
            return 0;
        }

        // Winners get their stake back plus proportional share of losing stakes
        return (userWinningVotes * total) / winningTotal;
    }

    function claim(address pool) public nonReentrant {
        require(!hasClaimed[pool][_msgSender()], "Payout already claimed");

        uint256 userVoted = yesVotesByUser[pool][_msgSender()] + noVotesByUser[pool][_msgSender()];
        require(userVoted > 0, "No votes to claim");

        uint256 claimable = calculateClaim(pool, _msgSender());

        hasClaimed[pool][_msgSender()] = true;

        // Clear user's votes for this pool
        yesVotesByUser[pool][_msgSender()] = 0;
        noVotesByUser[pool][_msgSender()] = 0;

        // Transfer winnings (0 for losers, stake + winnings for winners)
        if (claimable > 0) {
            votingToken.transfer(_msgSender(), claimable);
        }

        emit VotingClaimed(pool, _msgSender(), claimable);
    }

    // View function for frontend
    function getUserVotes(address pool, address user) public view returns (
        uint256 yesVotes,
        uint256 noVotes,
        uint256 claimableAmount,
        bool claimed
    ) {
        uint256 claimable = 0;
        uint256 votingClosesAt = AMM(pool).resolutionClose();
        if (block.timestamp >= votingClosesAt) {
            claimable = calculateClaim(pool, user);
        }
        return (
            yesVotesByUser[pool][user],
            noVotesByUser[pool][user],
            claimable,
            hasClaimed[pool][user]
        );
    }

    function getPoolVotingInfo(address pool) public view returns (
        uint256 totalYes,
        uint256 totalNo,
        uint256 voterCount,
        bool yesWinning
    ) {
        uint256 yesVotes = yesVotesTotal[pool];
        uint256 noVotes = noVotesTotal[pool];
        return (
            yesVotes,
            noVotes,
            votingUsersByPool[pool].length,
            yesVotes > noVotes
        );
    }
}
