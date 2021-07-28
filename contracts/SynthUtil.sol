pragma solidity ^0.6.10;

// Inheritance
import "./interfaces/ISynth.sol";
import "./interfaces/IDPassive.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IERC20.sol";

contract SynthUtil {
    IAddressResolver public addressResolverProxy;

    bytes32 internal constant CONTRACT_DPASSIVE = "DPassive";
    bytes32 internal constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 internal constant DUSD = "dUSD";

    constructor(address resolver) public {
        addressResolverProxy = IAddressResolver(resolver);
    }

    function _dpassive() internal view returns (IDPassive) {
        return IDPassive(addressResolverProxy.requireAndGetAddress(CONTRACT_DPASSIVE, "Missing DPassive address"));
    }

    function _exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(addressResolverProxy.requireAndGetAddress(CONTRACT_EXRATES, "Missing ExchangeRates address"));
    }

    function totalSynthsInKey(address account, bytes32 currencyKey) external view returns (uint total) {
        IDPassive dpassive = _dpassive();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numSynths = dpassive.availableSynthCount();
        for (uint i = 0; i < numSynths; i++) {
            ISynth synth = dpassive.availableSynths(i);
            total += exchangeRates.effectiveValue(
                synth.currencyKey(),
                IERC20(address(synth)).balanceOf(account),
                currencyKey
            );
        }
        return total;
    }

    function synthsBalances(address account)
        external
        view
        returns (
            bytes32[] memory,
            uint[] memory,
            uint[] memory
        )
    {
        IDPassive dpassive = _dpassive();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numSynths = dpassive.availableSynthCount();
        bytes32[] memory currencyKeys = new bytes32[](numSynths);
        uint[] memory balances = new uint[](numSynths);
        uint[] memory dUSDBalances = new uint[](numSynths);
        for (uint i = 0; i < numSynths; i++) {
            ISynth synth = dpassive.availableSynths(i);
            currencyKeys[i] = synth.currencyKey();
            balances[i] = IERC20(address(synth)).balanceOf(account);
            dUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], DUSD);
        }
        return (currencyKeys, balances, dUSDBalances);
    }

    function frozenSynths() external view returns (bytes32[] memory) {
        IDPassive dpassive = _dpassive();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numSynths = dpassive.availableSynthCount();
        bytes32[] memory frozenSynthsKeys = new bytes32[](numSynths);
        for (uint i = 0; i < numSynths; i++) {
            ISynth synth = dpassive.availableSynths(i);
            if (exchangeRates.rateIsFrozen(synth.currencyKey())) {
                frozenSynthsKeys[i] = synth.currencyKey();
            }
        }
        return frozenSynthsKeys;
    }

    function synthsRates() external view returns (bytes32[] memory, uint[] memory) {
        bytes32[] memory currencyKeys = _dpassive().availableCurrencyKeys();
        return (currencyKeys, _exchangeRates().ratesForCurrencies(currencyKeys));
    }

    function synthsTotalSupplies()
        external
        view
        returns (
            bytes32[] memory,
            uint256[] memory,
            uint256[] memory
        )
    {
        IDPassive dpassive = _dpassive();
        IExchangeRates exchangeRates = _exchangeRates();

        uint256 numSynths = dpassive.availableSynthCount();
        bytes32[] memory currencyKeys = new bytes32[](numSynths);
        uint256[] memory balances = new uint256[](numSynths);
        uint256[] memory dUSDBalances = new uint256[](numSynths);
        for (uint256 i = 0; i < numSynths; i++) {
            ISynth synth = dpassive.availableSynths(i);
            currencyKeys[i] = synth.currencyKey();
            balances[i] = IERC20(address(synth)).totalSupply();
            dUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], DUSD);
        }
        return (currencyKeys, balances, dUSDBalances);
    }
}
