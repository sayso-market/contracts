// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./AMM.sol";
import "./ResolutionOracle.sol";

contract MarketFactory is Ownable {
    ERC20 public tradingToken;
    ResolutionOracle public oracle;
    address public trustedForwarder;
    address public feeCollector;

    // Minimum seed to prevent share inflation attacks
    uint256 public constant MIN_SEED = 10e6; // 10 USDC minimum (6 decimals)

    // All markets created by this factory
    address[] public markets;
    mapping(address => bool) public isMarket;
    
    // Events
    event MarketCreated(
        address indexed market,
        string name,
        uint256 effectiveFrom,
        uint256 effectiveTo,
        uint256 resolutionOpen,
        uint256 resolutionClose
    );
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event TradingTokenUpdated(address indexed oldToken, address indexed newToken);
    event TrustedForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);

    constructor(
        ERC20 _tradingToken,
        ResolutionOracle _oracle,
        address _trustedForwarder,
        address _feeCollector
    ) Ownable(msg.sender) {
        require(address(_tradingToken) != address(0), "Trading token cannot be zero address");
        require(address(_oracle) != address(0), "Oracle cannot be zero address");
        require(_trustedForwarder != address(0), "Forwarder cannot be zero address");
        require(_feeCollector != address(0), "Fee collector cannot be zero address");

        tradingToken = _tradingToken;
        oracle = _oracle;
        trustedForwarder = _trustedForwarder;
        feeCollector = _feeCollector;
    }
    
    function createMarket(
        string memory name,
        uint256 effectiveFrom,
        uint256 effectiveTo,
        uint256 resolutionOpen,
        uint256 resolutionClose,
        uint256 initialYesTokens,
        uint256 initialNoTokens,
        address _resolver
    ) public returns (address) {
        uint256 totalSeed = initialYesTokens + initialNoTokens;

        // Enforce minimum seed
        require(totalSeed >= MIN_SEED, "Seed below minimum (10 USDC required)");

        // Transfer seed liquidity from creator to factory (will be transferred to market)
        if (totalSeed > 0) {
            require(
                tradingToken.transferFrom(msg.sender, address(this), totalSeed),
                "Seed transfer failed"
            );
        }

        // Calculate LMSR liquidity parameter (b)
        // b determines market depth: higher b = less slippage, more liquidity
        // Using 15x multiplier so $50 bets on a 10 USDC seed move price ~15% (not 50%+)
        // Safe because payouts are bounded by actual deposits, not LMSR cost function
        uint256 liquidityParameter = totalSeed * 1e12 * 15;

        // Deploy market with initial liquidity
        AMM market = new AMM(
            trustedForwarder,
            tradingToken,
            oracle,
            name,
            effectiveFrom,
            effectiveTo,
            resolutionOpen,
            resolutionClose,
            initialYesTokens,
            initialNoTokens,
            feeCollector,
            liquidityParameter,
            msg.sender, // Seed provider receives initial shares
            _resolver
        );

        address marketAddress = address(market);

        // Transfer seed tokens to the market
        if (totalSeed > 0) {
            require(
                tradingToken.transfer(marketAddress, totalSeed),
                "Market funding failed"
            );
        }

        markets.push(marketAddress);
        isMarket[marketAddress] = true;

        emit MarketCreated(
            marketAddress,
            name,
            effectiveFrom,
            effectiveTo,
            resolutionOpen,
            resolutionClose
        );

        return marketAddress;
    }
    
    // View functions
    function getMarketCount() public view returns (uint256) {
        return markets.length;
    }
    
    function getAllMarkets() public view returns (address[] memory) {
        return markets;
    }

    // Paginated market getter
    function getMarkets(uint256 offset, uint256 limit)
        public
        view
        returns (address[] memory)
    {
        uint256 total = markets.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = markets[offset + i];
        }
        return result;
    }

    function getActiveMarkets() public view returns (address[] memory) {
        uint256 activeCount = 0;
        
        // First pass: count active markets
        for (uint256 i = 0; i < markets.length; i++) {
            AMM market = AMM(markets[i]);
            if (block.timestamp >= market.effectiveFrom() && 
                block.timestamp <= market.effectiveTo()) {
                activeCount++;
            }
        }
        
        // Second pass: collect active markets
        address[] memory activeMarkets = new address[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < markets.length; i++) {
            AMM market = AMM(markets[i]);
            if (block.timestamp >= market.effectiveFrom() && 
                block.timestamp <= market.effectiveTo()) {
                activeMarkets[index] = markets[i];
                index++;
            }
        }
        
        return activeMarkets;
    }
    
    function getMarketsByStatus() public view returns (
        address[] memory trading,
        address[] memory resolution,
        address[] memory resolved
    ) {
        uint256 tradingCount = 0;
        uint256 resolutionCount = 0;
        uint256 resolvedCount = 0;
        
        // First pass: count by status
        for (uint256 i = 0; i < markets.length; i++) {
            AMM market = AMM(markets[i]);
            if (block.timestamp < market.effectiveFrom()) {
                // Upcoming - count as trading (will be)
            } else if (block.timestamp <= market.effectiveTo()) {
                tradingCount++;
            } else if (block.timestamp <= market.resolutionClose()) {
                resolutionCount++;
            } else {
                resolvedCount++;
            }
        }
        
        // Second pass: collect by status
        trading = new address[](tradingCount);
        resolution = new address[](resolutionCount);
        resolved = new address[](resolvedCount);
        
        uint256 tIdx = 0;
        uint256 rIdx = 0;
        uint256 dIdx = 0;
        
        for (uint256 i = 0; i < markets.length; i++) {
            AMM market = AMM(markets[i]);
            if (block.timestamp >= market.effectiveFrom() && 
                block.timestamp <= market.effectiveTo()) {
                trading[tIdx++] = markets[i];
            } else if (block.timestamp > market.effectiveTo() && 
                       block.timestamp <= market.resolutionClose()) {
                resolution[rIdx++] = markets[i];
            } else if (block.timestamp > market.resolutionClose()) {
                resolved[dIdx++] = markets[i];
            }
        }
        
        return (trading, resolution, resolved);
    }
    
    // Update oracle (admin only) - for new markets only
    function setOracle(ResolutionOracle _oracle) public onlyOwner {
        require(address(_oracle) != address(0), "Oracle cannot be zero address");
        address oldOracle = address(oracle);
        oracle = _oracle;
        emit OracleUpdated(oldOracle, address(_oracle));
    }

    // Update trading token (admin only) - for new markets only
    function setTradingToken(ERC20 _token) public onlyOwner {
        require(address(_token) != address(0), "Token cannot be zero address");
        address oldToken = address(tradingToken);
        tradingToken = _token;
        emit TradingTokenUpdated(oldToken, address(_token));
    }

    // Update trusted forwarder (admin only) - for new markets only
    function setTrustedForwarder(address _trustedForwarder) public onlyOwner {
        require(_trustedForwarder != address(0), "Forwarder cannot be zero address");
        address oldForwarder = trustedForwarder;
        trustedForwarder = _trustedForwarder;
        emit TrustedForwarderUpdated(oldForwarder, _trustedForwarder);
    }

    // Update fee collector (admin only) - for new markets only
    function setFeeCollector(address _feeCollector) public onlyOwner {
        require(_feeCollector != address(0), "Fee collector cannot be zero address");
        address oldCollector = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(oldCollector, _feeCollector);
    }

    // Recover any ERC20 tokens sent to this contract
    function recoverTokens(ERC20 token, address recipient) public onlyOwner {
        require(recipient != address(0), "Recipient cannot be zero address");
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to recover");
        require(token.transfer(recipient, balance), "Transfer failed");
    }
}
