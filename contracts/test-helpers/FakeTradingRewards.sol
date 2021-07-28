pragma solidity ^0.6.10;

import "../TradingRewards.sol";

import "../interfaces/IExchanger.sol";

contract FakeTradingRewards is TradingRewards {
    IERC20 public _mockDPassiveToken;

    constructor(
        address owner,
        address periodController,
        address resolver,
        address mockDPassiveToken
    ) public TradingRewards(owner, periodController, resolver) {
        _mockDPassiveToken = IERC20(mockDPassiveToken);
    }

    // DPassive is mocked with an ERC20 token passed via the constructor.
    function dpassive() internal view override returns (IERC20) {
        return IERC20(_mockDPassiveToken);
    }

    // Return msg.sender so that onlyExchanger modifier can be bypassed.
    function exchanger() internal view override returns (IExchanger) {
        return IExchanger(msg.sender);
    }
}
