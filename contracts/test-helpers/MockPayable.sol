pragma solidity ^0.6.10;

contract MockPayable {
    uint256 public paidTimes;

    function pay() external payable {
        require(msg.value > 0, "No value paid");
        paidTimes = paidTimes + 1;
    }
}
