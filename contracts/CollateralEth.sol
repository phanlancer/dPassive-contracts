pragma solidity ^0.6.10;

pragma experimental ABIEncoderV2;

// Inheritance
import "./Collateral.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ICollateralEth.sol";

// Internal references
import "./CollateralState.sol";

// This contract handles the payable aspects of eth loans.
contract CollateralEth is Collateral, ICollateralEth, ReentrancyGuard {
    mapping(address => uint) public pendingWithdrawals;

    constructor(
        CollateralState _state,
        address _owner,
        address _manager,
        address _resolver,
        bytes32 _collateralKey,
        uint _minCratio,
        uint _minCollateral
    ) public Collateral(_state, _owner, _manager, _resolver, _collateralKey, _minCratio, _minCollateral) {}

    function open(uint amount, bytes32 currency) external payable override {
        openInternal(msg.value, amount, currency, false);
    }

    function close(uint id) external override {
        uint collateral = closeInternal(msg.sender, id);

        pendingWithdrawals[msg.sender] = pendingWithdrawals[msg.sender].add(collateral);
    }

    function deposit(address borrower, uint id) external payable override {
        depositInternal(borrower, id, msg.value);
    }

    function withdraw(uint id, uint withdrawAmount) external override {
        uint amount = withdrawInternal(id, withdrawAmount);

        pendingWithdrawals[msg.sender] = pendingWithdrawals[msg.sender].add(amount);
    }

    function repay(
        address account,
        uint id,
        uint amount
    ) external override {
        repayInternal(account, msg.sender, id, amount);
    }

    function draw(uint id, uint amount) external {
        drawInternal(id, amount);
    }

    function liquidate(
        address borrower,
        uint id,
        uint amount
    ) external override {
        uint collateralLiquidated = liquidateInternal(borrower, id, amount);

        pendingWithdrawals[msg.sender] = pendingWithdrawals[msg.sender].add(collateralLiquidated);
    }

    function claim(uint amount) external override nonReentrant {
        // If they try to withdraw more than their total balance, it will fail on the safe sub.
        pendingWithdrawals[msg.sender] = pendingWithdrawals[msg.sender].sub(amount);
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
    }
}
