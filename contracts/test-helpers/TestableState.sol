pragma solidity ^0.6.10;

import "../Owned.sol";
import "../State.sol";

contract TestableState is Owned, State {
    constructor(address _owner, address _associatedContract) public Owned(_owner) State(_associatedContract) {}

    function testModifier() external onlyAssociatedContract {}
}
