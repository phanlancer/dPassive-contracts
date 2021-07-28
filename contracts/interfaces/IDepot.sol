pragma solidity ^0.6.10;

interface IDepot {
    // Views
    function fundsWallet() external view returns (address payable);

    function maxEthPurchase() external view returns (uint);

    function minimumDepositAmount() external view returns (uint);

    function synthsReceivedForEther(uint amount) external view returns (uint);

    function totalSellableDeposits() external view returns (uint);

    // Mutative functions
    function depositSynths(uint amount) external;

    function exchangeEtherForSynths() external payable returns (uint);

    function exchangeEtherForSynthsAtRate(uint guaranteedRate) external payable returns (uint);

    function withdrawMyDepositedSynths() external;

    // Note: On mainnet no DPS has been deposited. The following functions are kept alive for testnet DPS faucets.
    function exchangeEtherForDPS() external payable returns (uint);

    function exchangeEtherForDPSAtRate(uint guaranteedRate, uint guaranteedDPassiveRate) external payable returns (uint);

    function exchangeSynthsForDPS(uint synthAmount) external returns (uint);

    function dpassiveReceivedForEther(uint amount) external view returns (uint);

    function dpassiveReceivedForSynths(uint amount) external view returns (uint);

    function withdrawDPassive(uint amount) external;
}
