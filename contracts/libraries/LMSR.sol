// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";
import {UD60x18, ud} from "@prb/math/src/UD60x18.sol";
import {exp as sdExp} from "@prb/math/src/sd59x18/Math.sol";
import {ln as sdLn} from "@prb/math/src/sd59x18/Math.sol";
import {ln as udLn} from "@prb/math/src/ud60x18/Math.sol";

/**
 * @title LMSR - Logarithmic Market Scoring Rule Library
 * @notice Implements LMSR pricing for binary prediction markets using PRBMath
 * @dev Based on industry-standard LMSR used by Augur, Gnosis, etc.
 *
 * Uses PRBMath for accurate fixed-point math (prevents precision issues)
 *
 * Core Formula:
 * C(q) = b * ln(e^(q_yes/b) + e^(q_no/b))
 *
 * Price: p_yes = e^(q_yes/b) / (e^(q_yes/b) + e^(q_no/b))
 * Cost: cost = C(q_yes + n, q_no) - C(q_yes, q_no)
 */
library LMSR {
    // Fixed-point precision (18 decimals)
    uint256 constant PRECISION = 1e18;

    /**
     * @notice Calculate cost function C(q_yes, q_no) = b * ln(e^(q_yes/b) + e^(q_no/b))
     * @param qYes Quantity of YES shares outstanding (18 decimals)
     * @param qNo Quantity of NO shares outstanding (18 decimals)
     * @param b Liquidity parameter (18 decimals)
     * @return Cost in tokens (18 decimals)
     */
    function costFunction(uint256 qYes, uint256 qNo, uint256 b)
        internal
        pure
        returns (uint256)
    {
        require(b > 0, "Liquidity parameter must be positive");

        // Calculate qYes/b and qNo/b as SD59x18
        SD59x18 yesRatio = sd(int256(qYes)).div(sd(int256(b)));
        SD59x18 noRatio = sd(int256(qNo)).div(sd(int256(b)));

        // Calculate e^(qYes/b) and e^(qNo/b)
        SD59x18 expYes = sdExp(yesRatio);
        SD59x18 expNo = sdExp(noRatio);

        // Sum (convert to unsigned for addition)
        UD60x18 expYesUD = ud(uint256(expYes.unwrap()));
        UD60x18 expNoUD = ud(uint256(expNo.unwrap()));
        UD60x18 sum = expYesUD.add(expNoUD);

        // ln(sum)
        SD59x18 lnSum = udLn(sum).intoSD59x18();

        // b * ln(sum)
        SD59x18 result = lnSum.mul(sd(int256(b)));

        // Return as uint256
        int256 resultInt = result.unwrap();
        require(resultInt >= 0, "Cost must be non-negative");
        return uint256(resultInt);
    }

    /**
     * @notice Calculate cost to buy n shares of YES
     * @param qYesBefore Current YES shares
     * @param qNo Current NO shares
     * @param n Number of shares to buy
     * @param b Liquidity parameter
     * @return Cost in tokens
     */
    function buyCost(
        uint256 qYesBefore,
        uint256 qNo,
        uint256 n,
        uint256 b
    ) internal pure returns (uint256) {
        require(n > 0, "Amount must be positive");
        uint256 costBefore = costFunction(qYesBefore, qNo, b);
        uint256 costAfter = costFunction(qYesBefore + n, qNo, b);
        require(costAfter >= costBefore, "Cost calculation error");
        return costAfter - costBefore;
    }

    /**
     * @notice Calculate payout for selling n shares of YES
     * @param qYesBefore Current YES shares
     * @param qNo Current NO shares
     * @param n Number of shares to sell
     * @param b Liquidity parameter
     * @return Payout in tokens
     */
    function sellPayout(
        uint256 qYesBefore,
        uint256 qNo,
        uint256 n,
        uint256 b
    ) internal pure returns (uint256) {
        require(n > 0, "Amount must be positive");
        require(qYesBefore >= n, "Insufficient shares");
        uint256 costBefore = costFunction(qYesBefore, qNo, b);
        uint256 costAfter = costFunction(qYesBefore - n, qNo, b);
        require(costBefore >= costAfter, "Payout calculation error");
        return costBefore - costAfter;
    }

    /**
     * @notice Calculate current price of YES
     * @param qYes Current YES shares
     * @param qNo Current NO shares
     * @param b Liquidity parameter
     * @return Price as fraction of PRECISION (0 to PRECISION = 0% to 100%)
     */
    function priceYes(uint256 qYes, uint256 qNo, uint256 b)
        internal
        pure
        returns (uint256)
    {
        require(b > 0, "Liquidity parameter must be positive");

        // Calculate qYes/b and qNo/b
        SD59x18 yesRatio = sd(int256(qYes)).div(sd(int256(b)));
        SD59x18 noRatio = sd(int256(qNo)).div(sd(int256(b)));

        // Calculate e^(qYes/b) and e^(qNo/b)
        SD59x18 expYes = sdExp(yesRatio);
        SD59x18 expNo = sdExp(noRatio);

        // Convert to unsigned for division
        UD60x18 expYesUD = ud(uint256(expYes.unwrap()));
        UD60x18 expNoUD = ud(uint256(expNo.unwrap()));

        // p_yes = e^(qYes/b) / (e^(qYes/b) + e^(qNo/b))
        UD60x18 denominator = expYesUD.add(expNoUD);
        UD60x18 price = expYesUD.div(denominator);

        return price.unwrap();
    }

    /**
     * @notice Calculate number of shares that can be bought with given cost
     * @dev Uses binary search
     * @param targetCost Amount of tokens to spend
     * @param qYesBefore Current YES shares
     * @param qNo Current NO shares
     * @param b Liquidity parameter
     * @param isYes True for YES shares, false for NO
     * @return Number of shares
     */
    function sharesForCost(
        uint256 targetCost,
        uint256 qYesBefore,
        uint256 qNo,
        uint256 b,
        bool isYes
    ) internal pure returns (uint256) {
        require(targetCost > 0, "Cost must be positive");

        // Binary search bounds
        uint256 low = 0;
        // Upper bound: 5x handles down to ~20% price
        // Conservative to avoid PRBMath overflow
        uint256 high = targetCost * 5;
        uint256 shares = 0;

        // Binary search (max 256 iterations)
        for (uint256 i = 0; i < 256; i++) {
            uint256 mid = (low + high) / 2;
            if (mid == 0) {
                mid = 1;
            }

            uint256 cost;
            if (isYes) {
                cost = buyCost(qYesBefore, qNo, mid, b);
            } else {
                cost = buyCost(qNo, qYesBefore, mid, b); // Swap for NO
            }

            if (cost <= targetCost) {
                shares = mid;
                low = mid + 1;
            } else {
                if (high == 0) break;
                high = mid > 0 ? mid - 1 : 0;
            }

            if (low > high) break;
        }

        return shares;
    }
}
