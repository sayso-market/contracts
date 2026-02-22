// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockUSDC with ERC-2612 Permit
/// @notice Mimics real USDC's permit functionality for gasless approvals
contract USDC is ERC20, ERC20Permit {
    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {
        _mint(msg.sender, 1000000000000000); // 1B USDC
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // For testing purposes (real USDC doesn't have this)
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
