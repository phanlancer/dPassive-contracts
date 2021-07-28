pragma solidity ^0.6.10;

import "./interfaces/ICollateralManager.sol";

contract EmptyCollateralManager is ICollateralManager {
    // Manager information
    function hasCollateral(address) external view override returns (bool) {
        return false;
    }

    function isSynthManaged(bytes32) external view override returns (bool) {
        return false;
    }

    // State information
    function long(bytes32) external view override returns (uint amount) {
        return 0;
    }

    function short(bytes32) external view override returns (uint amount) {
        return 0;
    }

    function totalLong() external view override returns (uint dUSDValue, bool anyRateIsInvalid) {
        return (0, false);
    }

    function totalShort() external view override returns (uint dUSDValue, bool anyRateIsInvalid) {
        return (0, false);
    }

    function getBorrowRate() external view override returns (uint borrowRate, bool anyRateIsInvalid) {
        return (0, false);
    }

    function getShortRate(bytes32) external view override returns (uint shortRate, bool rateIsInvalid) {
        return (0, false);
    }

    function getRatesAndTime(uint)
        external
        view
        override
        returns (
            uint entryRate,
            uint lastRate,
            uint lastUpdated,
            uint newIndex
        )
    {
        return (0, 0, 0, 0);
    }

    function getShortRatesAndTime(bytes32, uint)
        external
        view
        override
        returns (
            uint entryRate,
            uint lastRate,
            uint lastUpdated,
            uint newIndex
        )
    {
        return (0, 0, 0, 0);
    }

    function exceedsDebtLimit(uint, bytes32) external view override returns (bool canIssue, bool anyRateIsInvalid) {
        return (false, false);
    }

    function areSynthsAndCurrenciesSet(bytes32[] calldata, bytes32[] calldata) external view override returns (bool) {
        return false;
    }

    function areShortableSynthsSet(bytes32[] calldata, bytes32[] calldata) external view override returns (bool) {
        return false;
    }

    // Loans
    function getNewLoanId() external override returns (uint id) {
        return 0;
    }

    // Manager mutative
    function addCollaterals(address[] calldata) external override {}

    function removeCollaterals(address[] calldata) external override {}

    function addSynths(bytes32[] calldata, bytes32[] calldata) external override {}

    function removeSynths(bytes32[] calldata, bytes32[] calldata) external override {}

    function addShortableSynths(bytes32[2][] calldata, bytes32[] calldata) external override {}

    function removeShortableSynths(bytes32[] calldata) external override {}

    // State mutative
    function updateBorrowRates(uint) external override {}

    function updateShortRates(bytes32, uint) external override {}

    function incrementLongs(bytes32, uint) external override {}

    function decrementLongs(bytes32, uint) external override {}

    function incrementShorts(bytes32, uint) external override {}

    function decrementShorts(bytes32, uint) external override {}
}
