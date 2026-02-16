// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../libraries/LMSR.sol";

/**
 * @title TestLMSR
 * @notice Test contract to expose LMSR library functions
 * @dev Used for unit testing the LMSR library
 */
contract TestLMSR {
    using LMSR for uint256;

    function priceYes(uint256 qYes, uint256 qNo, uint256 b)
        external
        pure
        returns (uint256)
    {
        return LMSR.priceYes(qYes, qNo, b);
    }

    function costFunction(uint256 qYes, uint256 qNo, uint256 b)
        external
        pure
        returns (uint256)
    {
        return LMSR.costFunction(qYes, qNo, b);
    }

    function buyCost(uint256 qYes, uint256 qNo, uint256 shares, uint256 b)
        external
        pure
        returns (uint256)
    {
        return LMSR.buyCost(qYes, qNo, shares, b);
    }

    function sellPayout(uint256 qYes, uint256 qNo, uint256 shares, uint256 b)
        external
        pure
        returns (uint256)
    {
        return LMSR.sellPayout(qYes, qNo, shares, b);
    }

    function sharesForCost(
        uint256 targetCost,
        uint256 qYes,
        uint256 qNo,
        uint256 b,
        bool isYes
    ) external pure returns (uint256) {
        return LMSR.sharesForCost(targetCost, qYes, qNo, b, isYes);
    }
}
