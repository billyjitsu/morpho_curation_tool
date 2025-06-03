// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FakeWETH is ERC20, Ownable {
    constructor(address recipient, address initialOwner)
        ERC20("FakeWETH", "FWETH")
        Ownable(initialOwner)
    {
        _mint(recipient, 10000000 * 10 ** decimals());
    }

    function mint() public {
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }
}