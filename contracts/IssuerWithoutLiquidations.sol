pragma solidity ^0.6.10;

// Internal references
import "./Issuer.sol";

contract IssuerWithoutLiquidations is Issuer {
    constructor(address _owner, address _resolver) public Issuer(_owner, _resolver) {}

    function liquidateDelinquentAccount(
        address account,
        uint dUSDAmount,
        address liquidator
    ) external override onlyDPassive returns (uint totalRedeemed, uint amountToLiquidate) {}
}
