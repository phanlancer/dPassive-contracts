pragma solidity ^0.6.10;

// Inheritance
import "./Owned.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IEtherWrapper.sol";
import "./interfaces/ISynth.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IWETH.sol";

// Internal references
import "./Pausable.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IFeePool.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";

// Libraries
import "@openzeppelin/contracts/math/SafeMath.sol";
import "./SafeDecimalMath.sol";

contract EtherWrapper is Owned, Pausable, MixinResolver, MixinSystemSettings, IEtherWrapper {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    /* ========== CONSTANTS ============== */

    /* ========== ENCODED NAMES ========== */

    bytes32 internal constant dUSD = "dUSD";
    bytes32 internal constant dETH = "dETH";
    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant DPS = "DPS";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_SYNTHSETH = "SynthdETH";
    bytes32 private constant CONTRACT_SYNTHDUSD = "SynthdUSD";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";

    // ========== STATE VARIABLES ==========
    IWETH internal _weth;

    uint public dETHIssued = 0;
    uint public dUSDIssued = 0;
    uint public feesEscrowed = 0;

    constructor(
        address _owner,
        address _resolver,
        address payable _WETH
    ) public Owned(_owner) Pausable() MixinSystemSettings(_resolver) {
        _weth = IWETH(_WETH);
    }

    /* ========== VIEWS ========== */
    function resolverAddressesRequired()
        public
        view
        override(MixinResolver, MixinSystemSettings)
        returns (bytes32[] memory addresses)
    {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](5);
        newAddresses[0] = CONTRACT_SYNTHSETH;
        newAddresses[1] = CONTRACT_SYNTHDUSD;
        newAddresses[2] = CONTRACT_EXRATES;
        newAddresses[3] = CONTRACT_ISSUER;
        newAddresses[4] = CONTRACT_FEEPOOL;
        addresses = combineArrays(existingAddresses, newAddresses);
        return addresses;
    }

    /* ========== INTERNAL VIEWS ========== */
    function synthdUSD() internal view returns (ISynth) {
        return ISynth(requireAndGetAddress(CONTRACT_SYNTHDUSD));
    }

    function synthdETH() internal view returns (ISynth) {
        return ISynth(requireAndGetAddress(CONTRACT_SYNTHSETH));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(requireAndGetAddress(CONTRACT_FEEPOOL));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    /* ========== PUBLIC FUNCTIONS ========== */

    // ========== VIEWS ==========

    function capacity() public view override returns (uint _capacity) {
        // capacity = max(maxETH - balance, 0)
        uint balance = getReserves();
        if (balance >= maxETH()) {
            return 0;
        }
        return maxETH().sub(balance);
    }

    function getReserves() public view override returns (uint) {
        return _weth.balanceOf(address(this));
    }

    function totalIssuedSynths() public view override returns (uint) {
        // This contract issues two different synths:
        // 1. dETH
        // 2. dUSD
        //
        // The dETH is always backed 1:1 with WETH.
        // The dUSD fees are backed by dETH that is withheld during minting and burning.
        return exchangeRates().effectiveValue(dETH, dETHIssued, dUSD).add(dUSDIssued);
    }

    function calculateMintFee(uint amount) public view override returns (uint) {
        return amount.multiplyDecimalRound(mintFeeRate());
    }

    function calculateBurnFee(uint amount) public view override returns (uint) {
        return amount.multiplyDecimalRound(burnFeeRate());
    }

    function maxETH() public view override returns (uint256) {
        return getEtherWrapperMaxETH();
    }

    function mintFeeRate() public view override returns (uint256) {
        return getEtherWrapperMintFeeRate();
    }

    function burnFeeRate() public view override returns (uint256) {
        return getEtherWrapperBurnFeeRate();
    }

    function weth() public view override returns (IWETH) {
        return _weth;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    // Transfers `amountIn` WETH to mint `amountIn - fees` dETH.
    // `amountIn` is inclusive of fees, calculable via `calculateMintFee`.
    function mint(uint amountIn) external override notPaused {
        require(amountIn <= _weth.allowance(msg.sender, address(this)), "Allowance not high enough");
        require(amountIn <= _weth.balanceOf(msg.sender), "Balance is too low");

        uint currentCapacity = capacity();
        require(currentCapacity > 0, "Contract has no spare capacity to mint");

        if (amountIn < currentCapacity) {
            _mint(amountIn);
        } else {
            _mint(currentCapacity);
        }
    }

    // Burns `amountIn` dETH for `amountIn - fees` WETH.
    // `amountIn` is inclusive of fees, calculable via `calculateBurnFee`.
    function burn(uint amountIn) external override notPaused {
        uint reserves = getReserves();
        require(reserves > 0, "Contract cannot burn dETH for WETH, WETH balance is zero");

        // principal = [amountIn / (1 + burnFeeRate)]
        uint principal = amountIn.divideDecimalRound(SafeDecimalMath.unit().add(burnFeeRate()));

        if (principal < reserves) {
            _burn(principal, amountIn);
        } else {
            _burn(reserves, reserves.add(calculateBurnFee(reserves)));
        }
    }

    function distributeFees() external override {
        // Normalize fee to dUSD
        require(!exchangeRates().rateIsInvalid(dETH), "Currency rate is invalid");
        uint amountDUSD = exchangeRates().effectiveValue(dETH, feesEscrowed, dUSD);

        // Burn dETH.
        synthdETH().burn(address(this), feesEscrowed);
        // Pay down as much dETH debt as we burn. Any other debt is taken on by the stakers.
        dETHIssued = dETHIssued < feesEscrowed ? 0 : dETHIssued.sub(feesEscrowed);

        // Issue dUSD to the fee pool
        issuer().synths(dUSD).issue(feePool().FEE_ADDRESS(), amountDUSD);
        dUSDIssued = dUSDIssued.add(amountDUSD);

        // Tell the fee pool about this
        feePool().recordFeePaid(amountDUSD);

        feesEscrowed = 0;
    }

    // ========== RESTRICTED ==========

    /**
     * @notice Fallback function
     */
    fallback() external payable {
        revert("Fallback disabled, use mint()");
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _mint(uint amountIn) internal {
        // Calculate minting fee.
        uint feeAmountEth = calculateMintFee(amountIn);
        uint principal = amountIn.sub(feeAmountEth);

        // Transfer WETH from user.
        _weth.transferFrom(msg.sender, address(this), amountIn);

        // Mint `amountIn - fees` dETH to user.
        synthdETH().issue(msg.sender, principal);

        // Escrow fee.
        synthdETH().issue(address(this), feeAmountEth);
        feesEscrowed = feesEscrowed.add(feeAmountEth);

        // Add dETH debt.
        dETHIssued = dETHIssued.add(amountIn);

        emit Minted(msg.sender, principal, feeAmountEth, amountIn);
    }

    function _burn(uint principal, uint amountIn) internal {
        // for burn, amount is inclusive of the fee.
        uint feeAmountEth = amountIn.sub(principal);

        require(amountIn <= IERC20(address(synthdETH())).allowance(msg.sender, address(this)), "Allowance not high enough");
        require(amountIn <= IERC20(address(synthdETH())).balanceOf(msg.sender), "Balance is too low");

        // Burn `amountIn` dETH from user.
        synthdETH().burn(msg.sender, amountIn);
        // dETH debt is repaid by burning.
        dETHIssued = dETHIssued < principal ? 0 : dETHIssued.sub(principal);

        // We use burn/issue instead of burning the principal and transferring the fee.
        // This saves an approval and is cheaper.
        // Escrow fee.
        synthdETH().issue(address(this), feeAmountEth);
        // We don't update dETHIssued, as only the principal was subtracted earlier.
        feesEscrowed = feesEscrowed.add(feeAmountEth);

        // Transfer `amount - fees` WETH to user.
        _weth.transfer(msg.sender, principal);

        emit Burned(msg.sender, principal, feeAmountEth, amountIn);
    }

    /* ========== EVENTS ========== */
    event Minted(address indexed account, uint principal, uint fee, uint amountIn);
    event Burned(address indexed account, uint principal, uint fee, uint amountIn);
}
