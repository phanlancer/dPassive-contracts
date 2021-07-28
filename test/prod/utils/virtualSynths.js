const { web3 } = require('hardhat');
const { connectContract } = require('./connectContract');

async function implementsVirtualSynths({ network, deploymentPath }) {
	const DPassive = await connectContract({
		network,
		deploymentPath,
		contractName: 'DPassive',
	});

	const code = await web3.eth.getCode(DPassive.address);
	const sighash = web3.eth.abi
		.encodeFunctionSignature('exchangeWithVirtual(bytes32,uint256,bytes32,bytes32)')
		.slice(2, 10);

	return code.includes(sighash);
}

module.exports = {
	implementsVirtualSynths,
};
