pragma solidity ^0.6.10;

import "../interfaces/IAddressResolver.sol";
import "../interfaces/IDPassive.sol";

contract MockThirdPartyExchangeContract {
    IAddressResolver public resolver;

    constructor(IAddressResolver _resolver) public {
        resolver = _resolver;
    }

    function exchange(
        bytes32 src,
        uint amount,
        bytes32 dest
    ) external {
        IDPassive dpassive = IDPassive(resolver.getAddress("DPassive"));

        dpassive.exchangeWithTrackingForInitiator(src, amount, dest, address(this), "TRACKING_CODE");
    }
}
