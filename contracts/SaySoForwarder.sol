// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

// Concrete implementation of ERC2771Forwarder for deployment
contract SaySoForwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("SaySoForwarder") {}
}
