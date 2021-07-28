pragma solidity ^0.6.10;

import "./IWETH.sol";

abstract contract IEtherWrapper {
    function mint(uint amount) external virtual;

    function burn(uint amount) external virtual;

    function distributeFees() external virtual;

    function capacity() external view virtual returns (uint);

    function getReserves() external view virtual returns (uint);

    function totalIssuedSynths() external view virtual returns (uint);

    function calculateMintFee(uint amount) public view virtual returns (uint);

    function calculateBurnFee(uint amount) public view virtual returns (uint);

    function maxETH() public view virtual returns (uint256);

    function mintFeeRate() public view virtual returns (uint256);

    function burnFeeRate() public view virtual returns (uint256);

    function weth() public view virtual returns (IWETH);
}
