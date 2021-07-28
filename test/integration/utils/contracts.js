const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const { getSource, getTarget } = require('../../..');

function connectContracts({ ctx }) {
	const network = 'local';

	const allTargets = getTarget({ fs, path, network });

	ctx.contracts = {};
	Object.entries(allTargets).map(([name, target]) => {
		ctx.contracts[name] = new ethers.Contract(
			getTarget({ fs, path, network, contract: name }).address,
			getSource({ fs, path, network, contract: target.source }).abi,
			ctx.provider
		);
	});
}

module.exports = {
	connectContracts,
};
