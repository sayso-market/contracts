// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract SaySoToken is ERC20, ERC20Permit, Ownable {
    uint256 public maxSupply = 100000000000000000000000000; // 100m
    constructor() ERC20("SaySo Token", "SAY") ERC20Permit("SaySo Token") Ownable(msg.sender) {
        _mint(msg.sender, 1000000000000000000000); // 1k
    }

    function mint(address to, uint256 amount) public onlyOwner {
        require(totalSupply() + amount <= maxSupply, "Exceeds max supply");
        _mint(to, amount);
    }
}
