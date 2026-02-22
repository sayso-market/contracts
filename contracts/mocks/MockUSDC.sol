// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";

/// @title MockUSDC with Production-Grade Parameters
/// @notice Exactly matches Circle's USDC permit parameters on Sei for accurate testing
/// @dev name="USD Coin", version="2" to match real Circle USDC (FiatTokenV2) on Sei mainnet
contract MockUSDC is ERC20, IERC20Permit, EIP712, Nonces {
    mapping(address => uint256) private _nonces;

    bytes32 private constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /**
     * @dev Initializes the contract with production USDC parameters:
     * - name: "USD Coin"
     * - symbol: "USDC"
     * - EIP712 domain version: "2"
     */
    constructor()
        ERC20("USD Coin", "USDC")
        EIP712("USD Coin", "2") // Matches real Circle USDC on Sei
    {
        _mint(msg.sender, 1000000000000000); // 1B USDC
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @dev See {IERC20Permit-permit}.
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual override {
        require(block.timestamp <= deadline, "ERC20Permit: expired deadline");

        bytes32 structHash = keccak256(abi.encode(_PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline));

        bytes32 hash = _hashTypedDataV4(structHash);

        address signer = ECDSA.recover(hash, v, r, s);
        require(signer == owner, "ERC20Permit: invalid signature");

        _approve(owner, spender, value);
    }

    /**
     * @dev See {IERC20Permit-nonces}.
     */
    function nonces(address owner) public view virtual override(IERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /**
     * @dev See {IERC20Permit-DOMAIN_SEPARATOR}.
     */
    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    // For testing purposes (real USDC doesn't have this)
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}