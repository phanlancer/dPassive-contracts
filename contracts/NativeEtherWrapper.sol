pragma solidity ^0.6.10;

// Inheritance
import "./Owned.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IEtherWrapper.sol";
import "./interfaces/ISynth.sol";
import "./interfaces/IWETH.sol";
import "./interfaces/IERC20.sol";

// Internal references
import "./MixinResolver.sol";
import "./interfaces/IEtherWrapper.sol";

contract NativeEtherWrapper is Owned, MixinResolver {
    bytes32 private constant CONTRACT_ETHER_WRAPPER = "EtherWrapper";
    bytes32 private constant CONTRACT_SYNTHSETH = "SynthdETH";

    constructor(address _owner, address _resolver) public Owned(_owner) MixinResolver(_resolver) {}

    /* ========== PUBLIC FUNCTIONS ========== */

    /* ========== VIEWS ========== */
    function resolverAddressesRequired() public view override returns (bytes32[] memory addresses) {
        addresses = new bytes32[](2);
        addresses[0] = CONTRACT_ETHER_WRAPPER;
        addresses[1] = CONTRACT_SYNTHSETH;
        return addresses;
    }

    function etherWrapper() internal view returns (IEtherWrapper) {
        return IEtherWrapper(requireAndGetAddress(CONTRACT_ETHER_WRAPPER));
    }

    function weth() internal view returns (IWETH) {
        return etherWrapper().weth();
    }

    function synthdETH() internal view returns (IERC20) {
        return IERC20(requireAndGetAddress(CONTRACT_SYNTHSETH));
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function mint() public payable {
        uint amount = msg.value;
        require(amount > 0, "msg.value must be greater than 0");

        // Convert sent ETH into WETH.
        weth().deposit.value(amount)();

        // Approve for the EtherWrapper.
        weth().approve(address(etherWrapper()), amount);

        // Now call mint.
        etherWrapper().mint(amount);

        // Transfer the dETH to msg.sender.
        synthdETH().transfer(msg.sender, synthdETH().balanceOf(address(this)));

        emit Minted(msg.sender, amount);
    }

    function burn(uint amount) public {
        require(amount > 0, "amount must be greater than 0");
        IWETH weth = weth();

        // Transfer dETH from the msg.sender.
        synthdETH().transferFrom(msg.sender, address(this), amount);

        // Approve for the EtherWrapper.
        synthdETH().approve(address(etherWrapper()), amount);

        // Now call burn.
        etherWrapper().burn(amount);

        // Convert WETH to ETH and send to msg.sender.
        weth.withdraw(weth.balanceOf(address(this)));
        // solhint-disable avoid-low-level-calls
        msg.sender.call.value(address(this).balance)("");

        emit Burned(msg.sender, amount);
    }

    receive() external payable {
        // Allow the WETH contract to send us ETH during
        // our call to WETH.deposit. The gas stipend it gives
        // is 2300 gas, so it's not possible to do much else here.
    }

    /* ========== EVENTS ========== */
    // While these events are replicated in the core EtherWrapper,
    // it is useful to see the usage of the NativeEtherWrapper contract.
    event Minted(address indexed account, uint amount);
    event Burned(address indexed account, uint amount);
}
