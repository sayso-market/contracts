// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ResolutionOracle.sol";
import "./libraries/LMSR.sol";

/**
 * @title AMM - LMSR-based Prediction Market
 * @notice Binary prediction market using Logarithmic Market Scoring Rule (LMSR)
 * @dev Uses LMSR bonding curve for proper slippage and automated market making
 */
contract AMM is ERC2771Context, ReentrancyGuard {
    using LMSR for uint256;

    ERC20 public token;
    ResolutionOracle public oracle;

    // Fee configuration (0.5% = 50 basis points)
    uint256 public constant FEE_BPS = 50;
    uint256 public constant BPS_DENOMINATOR = 10000;
    address public feeCollector;

    // Flash loan protection: minimum hold time before selling (blocks)
    uint256 public constant MIN_HOLD_BLOCKS = 10; // ~4 seconds on Sei
    mapping(address => uint256) public lastPurchaseBlock;

    // Minimum deposit to prevent share inflation attacks
    uint256 public constant MIN_DEPOSIT = 1e6; // 1 USDC minimum (6 decimals)

    // Market parameters
    string public name;
    uint256 public effectiveFrom;
    uint256 public effectiveTo;
    uint256 public resolutionOpen;
    uint256 public resolutionClose;

    // LMSR liquidity parameter (determines market depth/slippage)
    uint256 public liquidityParameter; // b in LMSR formula (18 decimals)

    // Outstanding shares for LMSR pricing (18 decimals for precision)
    uint256 public qYes; // Quantity of YES shares outstanding
    uint256 public qNo; // Quantity of NO shares outstanding

    // User share balances (for claiming after resolution)
    mapping(address => uint256) public yesBalances;
    mapping(address => uint256) public noBalances;
    uint256 public totalYes; // Total YES shares held by users
    uint256 public totalNo; // Total NO shares held by users

    // Internal accounting to prevent donation attacks
    uint256 public totalDeposited; // Net USDC deposited through trading

    mapping(address => bool) public hasClaimed;

    // Resolution state
    bool public resolved;
    bool public outcome; // true = yes wins, false = no wins
    bool public isTie; // true if votes were tied
    uint256 public resolvedPoolBalance; // Snapshot of pool at resolution time

    // Events
    event SharesPurchased(address indexed buyer, bool isYes, uint256 cost, uint256 shares, uint256 newPrice);
    event SharesSold(address indexed seller, bool isYes, uint256 shares, uint256 payout, uint256 newPrice);
    event MarketResolved(bool outcome, uint256 yesVotes, uint256 noVotes);
    event MarketResolvedWithTie(uint256 yesVotes, uint256 noVotes);
    event Claimed(address indexed user, uint256 amount);
    event FeeCollected(address indexed buyer, uint256 feeAmount);

    constructor(
        address _trustedForwarder,
        ERC20 _token,
        ResolutionOracle _oracle,
        string memory _name,
        uint256 _effectiveFrom,
        uint256 _effectiveTo,
        uint256 _resolutionOpen,
        uint256 _resolutionClose,
        uint256 _initialYesTokens,
        uint256 _initialNoTokens,
        address _feeCollector,
        uint256 _liquidityParameter,
        address _seedProvider
    ) ERC2771Context(_trustedForwarder) {
        // Zero-address validation
        require(_trustedForwarder != address(0), "Forwarder cannot be zero address");
        require(address(_token) != address(0), "Token cannot be zero address");
        require(address(_oracle) != address(0), "Oracle cannot be zero address");
        require(_feeCollector != address(0), "Fee collector cannot be zero address");

        // Timing validation
        require(_effectiveFrom < _effectiveTo, "Invalid trading period");
        require(_effectiveTo <= _resolutionOpen, "Trading must end before resolution");
        require(_resolutionOpen < _resolutionClose, "Invalid resolution period");

        // LMSR validation
        require(_liquidityParameter > 0, "Liquidity parameter must be positive");

        token = _token;
        oracle = _oracle;
        name = _name;
        effectiveFrom = _effectiveFrom;
        effectiveTo = _effectiveTo;
        resolutionOpen = _resolutionOpen;
        resolutionClose = _resolutionClose;
        feeCollector = _feeCollector;
        liquidityParameter = _liquidityParameter;

        // Initialize LMSR with seed liquidity (convert from 6 decimals to 18 decimals)
        // Factory's seed becomes initial outstanding shares
        qYes = _initialYesTokens * 1e12; // 6 decimals → 18 decimals
        qNo = _initialNoTokens * 1e12; // 6 decimals → 18 decimals

        // Initialize internal accounting with seed amount
        totalDeposited = _initialYesTokens + _initialNoTokens;

        // Seed provider (creator) receives initial shares
        if (_initialYesTokens > 0) {
            yesBalances[_seedProvider] = _initialYesTokens * 1e12;
            totalYes = _initialYesTokens * 1e12;
        }
        if (_initialNoTokens > 0) {
            noBalances[_seedProvider] = _initialNoTokens * 1e12;
            totalNo = _initialNoTokens * 1e12;
        }
    }

    modifier duringTradingPeriod() {
        require(
            block.timestamp >= effectiveFrom && block.timestamp <= effectiveTo,
            "Trading outside effective period"
        );
        _;
    }

    modifier canSell() {
        require(
            block.number >= lastPurchaseBlock[_msgSender()] + MIN_HOLD_BLOCKS,
            "Must wait before selling (flash loan protection)"
        );
        _;
    }

    /**
     * @notice Get current market price for YES shares
     * @return Price as fraction of 1e18 (0 to 1e18 = 0% to 100%)
     */
    function price() public view returns (uint256) {
        if (qYes == 0 && qNo == 0) {
            return 5e17; // 50% default for empty market
        }
        return LMSR.priceYes(qYes, qNo, liquidityParameter);
    }

    /**
     * @notice Buy YES shares with specified USDC amount (including fees)
     * @param maxCost Maximum USDC to spend (including 0.5% fee)
     * @dev User specifies cost, receives variable number of shares based on LMSR
     */
    function buyYes(uint256 maxCost) public duringTradingPeriod nonReentrant {
        require(maxCost > 0, "Amount must be greater than 0");
        require(maxCost >= MIN_DEPOSIT, "Deposit below minimum");

        // Transfer tokens from user
        token.transferFrom(_msgSender(), address(this), maxCost);

        // Deduct 0.5% fee
        uint256 fee = (maxCost * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netCost = maxCost - fee;

        // Transfer fee to collector
        if (fee > 0) {
            token.transfer(feeCollector, fee);
            emit FeeCollected(_msgSender(), fee);
        }

        // Convert netCost from 6 decimals to 18 decimals for LMSR
        uint256 netCostScaled = netCost * 1e12;

        // Calculate shares using LMSR (binary search for shares that cost ~netCostScaled)
        uint256 shares = LMSR.sharesForCost(
            netCostScaled,
            qYes,
            qNo,
            liquidityParameter,
            true // isYes
        );

        require(shares > 0, "Shares must be greater than 0");

        // Update state
        yesBalances[_msgSender()] += shares;
        totalYes += shares;
        qYes += shares; // Update outstanding shares for LMSR
        totalDeposited += netCost; // Track actual deposits (6 decimals)

        // Record purchase block for flash loan protection
        lastPurchaseBlock[_msgSender()] = block.number;

        emit SharesPurchased(_msgSender(), true, netCost, shares, price());
    }

    /**
     * @notice Buy NO shares with specified USDC amount (including fees)
     * @param maxCost Maximum USDC to spend (including 0.5% fee)
     * @dev User specifies cost, receives variable number of shares based on LMSR
     */
    function buyNo(uint256 maxCost) public duringTradingPeriod nonReentrant {
        require(maxCost > 0, "Amount must be greater than 0");
        require(maxCost >= MIN_DEPOSIT, "Deposit below minimum");

        // Transfer tokens from user
        token.transferFrom(_msgSender(), address(this), maxCost);

        // Deduct 0.5% fee
        uint256 fee = (maxCost * FEE_BPS) / BPS_DENOMINATOR;
        uint256 netCost = maxCost - fee;

        // Transfer fee to collector
        if (fee > 0) {
            token.transfer(feeCollector, fee);
            emit FeeCollected(_msgSender(), fee);
        }

        // Convert netCost from 6 decimals to 18 decimals for LMSR
        uint256 netCostScaled = netCost * 1e12;

        // Calculate shares using LMSR (parameters are always qYes, qNo regardless of side)
        uint256 shares = LMSR.sharesForCost(
            netCostScaled,
            qYes,
            qNo,
            liquidityParameter,
            false // isYes = false (buying NO side)
        );

        require(shares > 0, "Shares must be greater than 0");

        // Update state
        noBalances[_msgSender()] += shares;
        totalNo += shares;
        qNo += shares; // Update outstanding shares for LMSR
        totalDeposited += netCost; // Track actual deposits (6 decimals)

        // Record purchase block for flash loan protection
        lastPurchaseBlock[_msgSender()] = block.number;

        emit SharesPurchased(_msgSender(), false, netCost, shares, price());
    }

    /**
     * @notice Sell YES shares for USDC
     * @param shares Number of shares to sell (18 decimals)
     * @dev User specifies shares, receives variable USDC based on LMSR
     */
    function sellYes(uint256 shares) public duringTradingPeriod canSell nonReentrant {
        require(shares > 0, "Shares must be greater than 0");
        require(yesBalances[_msgSender()] >= shares, "Insufficient shares");

        // Calculate payout using LMSR
        uint256 payoutScaled = LMSR.sellPayout(qYes, qNo, shares, liquidityParameter);

        // Convert from 18 decimals to 6 decimals
        uint256 payout = payoutScaled / 1e12;
        require(payout > 0, "Payout too small");
        require(payout <= totalDeposited, "Insufficient liquidity");

        // Update state
        yesBalances[_msgSender()] -= shares;
        totalYes -= shares;
        qYes -= shares; // Update outstanding shares for LMSR
        totalDeposited -= payout; // Track actual withdrawals

        // Transfer payout to user
        token.transfer(_msgSender(), payout);

        emit SharesSold(_msgSender(), true, shares, payout, price());
    }

    /**
     * @notice Sell NO shares for USDC
     * @param shares Number of shares to sell (18 decimals)
     * @dev User specifies shares, receives variable USDC based on LMSR
     */
    function sellNo(uint256 shares) public duringTradingPeriod canSell nonReentrant {
        require(shares > 0, "Shares must be greater than 0");
        require(noBalances[_msgSender()] >= shares, "Insufficient shares");

        // Calculate payout using LMSR (swap qYes and qNo for NO)
        uint256 payoutScaled = LMSR.sellPayout(qNo, qYes, shares, liquidityParameter);

        // Convert from 18 decimals to 6 decimals
        uint256 payout = payoutScaled / 1e12;
        require(payout > 0, "Payout too small");
        require(payout <= totalDeposited, "Insufficient liquidity");

        // Update state
        noBalances[_msgSender()] -= shares;
        totalNo -= shares;
        qNo -= shares; // Update outstanding shares for LMSR
        totalDeposited -= payout; // Track actual withdrawals

        // Transfer payout to user
        token.transfer(_msgSender(), payout);

        emit SharesSold(_msgSender(), false, shares, payout, price());
    }

    /**
     * @notice Resolve the market based on oracle votes
     * @dev Can be called by anyone after resolution period ends
     */
    function resolve() public {
        require(block.timestamp >= resolutionClose, "Resolution period not ended");
        require(!resolved, "Already resolved");

        uint256 yesVotes = oracle.yesVotesTotal(address(this));
        uint256 noVotes = oracle.noVotesTotal(address(this));

        // Handle no-votes case: set resolved flag for proportional refunds
        if (yesVotes == 0 && noVotes == 0) {
            resolved = true;
            outcome = false; // Doesn't matter for refunds
            resolvedPoolBalance = totalDeposited; // Use internal accounting
            emit MarketResolved(false, 0, 0);
            return;
        }

        resolved = true;
        resolvedPoolBalance = totalDeposited; // Use internal accounting

        // Handle tie case: explicit detection and event
        if (yesVotes == noVotes && yesVotes > 0) {
            isTie = true;
            outcome = false; // Default to NO for ties (doesn't affect payouts)
            emit MarketResolvedWithTie(yesVotes, noVotes);
        } else {
            outcome = yesVotes > noVotes;
            emit MarketResolved(outcome, yesVotes, noVotes);
        }
    }

    /**
     * @notice Get the outcome of the market
     * @return yesWins True if YES wins, false otherwise
     * @return isResolved True if market is resolved
     */
    function getOutcome() public view returns (bool yesWins, bool isResolved) {
        if (!resolved) {
            // Check if we can determine outcome from oracle
            if (block.timestamp >= resolutionClose) {
                uint256 yesVotes = oracle.yesVotesTotal(address(this));
                uint256 noVotes = oracle.noVotesTotal(address(this));
                if (yesVotes > 0 || noVotes > 0) {
                    return (yesVotes > noVotes, true);
                }
            }
            return (false, false);
        }
        return (outcome, true);
    }

    /**
     * @notice Calculate how much a user can claim after resolution
     * @param user Address of the user
     * @return Claimable amount in USDC (6 decimals)
     */
    function calculateClaim(address user) public view returns (uint256) {
        require(block.timestamp >= resolutionClose, "Resolution not yet closed");

        if (hasClaimed[user]) {
            return 0;
        }

        // Use snapshotted pool balance if resolved, otherwise internal accounting for preview
        uint256 totalPoolBalance = resolved ? resolvedPoolBalance : totalDeposited;
        if (totalPoolBalance == 0) {
            return 0;
        }

        // Get outcome from oracle
        uint256 yesVotes = oracle.yesVotesTotal(address(this));
        uint256 noVotes = oracle.noVotesTotal(address(this));

        // No resolution votes - refund proportionally
        if (yesVotes == 0 && noVotes == 0) {
            // Calculate user's proportional share of deposits
            uint256 userYesShare = totalYes > 0 ? (yesBalances[user] * totalPoolBalance) / totalYes : 0;
            uint256 userNoShare = totalNo > 0 ? (noBalances[user] * totalPoolBalance) / totalNo : 0;
            return (userYesShare + userNoShare) / 2; // Average refund
        }

        // Handle tie: refund proportionally
        if (isTie || (yesVotes == noVotes && yesVotes > 0)) {
            uint256 userYesShare = totalYes > 0 ? (yesBalances[user] * totalPoolBalance) / totalYes : 0;
            uint256 userNoShare = totalNo > 0 ? (noBalances[user] * totalPoolBalance) / totalNo : 0;
            return (userYesShare + userNoShare) / 2; // Average refund
        }

        // Determine winner
        bool yesWins = yesVotes > noVotes;

        uint256 userShares;
        uint256 totalWinningShares;

        if (yesWins) {
            userShares = yesBalances[user];
            totalWinningShares = totalYes;
        } else {
            userShares = noBalances[user];
            totalWinningShares = totalNo;
        }

        if (totalWinningShares == 0 || userShares == 0) {
            return 0;
        }

        // Distribute the entire pool proportionally based on shares
        return (userShares * totalPoolBalance) / totalWinningShares;
    }

    /**
     * @notice Claim winnings after market resolution
     * @dev Automatically resolves market if not already resolved
     */
    function claim() public nonReentrant {
        require(block.timestamp >= resolutionClose, "Resolution not yet closed");
        require(!hasClaimed[_msgSender()], "Already claimed");

        // Ensure market is resolved
        if (!resolved) {
            resolve();
        }

        uint256 claimable = calculateClaim(_msgSender());
        require(claimable > 0, "No claimable amount");

        hasClaimed[_msgSender()] = true;
        token.transfer(_msgSender(), claimable);

        emit Claimed(_msgSender(), claimable);
    }

    // View functions for frontend
    function getMarketInfo() public view returns (
        string memory marketName,
        uint256 currentPrice,
        uint256 totalYesShares,
        uint256 totalNoShares,
        uint256 outstandingYes,
        uint256 outstandingNo
    ) {
        return (
            name,
            price(),
            totalYes,
            totalNo,
            qYes,
            qNo
        );
    }

    function getMarketTiming() public view returns (
        uint256 tradingStart,
        uint256 tradingEnd,
        uint256 resolutionStart,
        uint256 resolutionEnd,
        bool isResolved,
        bool marketOutcome
    ) {
        (bool _outcome, bool _isResolved) = getOutcome();
        return (
            effectiveFrom,
            effectiveTo,
            resolutionOpen,
            resolutionClose,
            _isResolved,
            _outcome
        );
    }

    function getUserPosition(address user) public view returns (
        uint256 yesShares,
        uint256 noShares,
        uint256 claimableAmount,
        bool claimed
    ) {
        uint256 claimable = 0;
        if (block.timestamp >= resolutionClose) {
            claimable = calculateClaim(user);
        }
        return (
            yesBalances[user],
            noBalances[user],
            claimable,
            hasClaimed[user]
        );
    }

    function canUserSell(address user) public view returns (bool) {
        return block.number >= lastPurchaseBlock[user] + MIN_HOLD_BLOCKS;
    }
}
