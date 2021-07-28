pragma solidity ^0.6.10;

interface IHasBalance {
    // Views
    function balanceOf(address account) external view returns (uint);
}
