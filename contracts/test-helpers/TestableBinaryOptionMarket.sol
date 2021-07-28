pragma solidity ^0.6.10;

import "../BinaryOptionMarket.sol";

contract TestableBinaryOptionMarket is BinaryOptionMarket {
    constructor(
        address _owner,
        address _creator,
        address _resolver,
        uint[2] memory _creatorLimits,
        bytes32 _oracleKey,
        uint256 _strikePrice,
        bool _refundsEnabled,
        uint[3] memory _times,
        uint[2] memory _bids,
        uint[3] memory _fees
    )
        public
        BinaryOptionMarket(
            _owner,
            _creator,
            _resolver,
            _creatorLimits,
            _oracleKey,
            _strikePrice,
            _refundsEnabled,
            _times,
            _bids,
            _fees
        )
    {}

    function updatePrices(
        uint256 longBids,
        uint256 shortBids,
        uint totalDebt
    ) public {
        _updatePrices(longBids, shortBids, totalDebt);
    }

    function setManager(address _manager) public {
        owner = _manager;
    }

    function forceClaim(address account) public {
        _options.long.claim(account, prices.long, _exercisableDeposits(deposited));
        _options.short.claim(account, prices.short, _exercisableDeposits(deposited));
    }
}
