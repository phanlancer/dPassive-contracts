const { toBytes32 } = require('../../..');
const { connectContract, connectContracts } = require('./connectContract');
const { getDecodedLogs } = require('../../contracts/helpers');

async function getExchangeLogsWithTradingRewards({ network, deploymentPath, exchangeTx }) {
	const { TradingRewards, DPassive } = await connectContracts({
		network,
		deploymentPath,
		requests: [{ contractName: 'TradingRewards' }, { contractName: 'DPassive' }],
	});

	const logs = await getDecodedLogs({
		hash: exchangeTx.tx,
		contracts: [DPassive, TradingRewards],
	});

	return logs.filter(log => log !== undefined);
}

async function getExchangeLogs({ network, deploymentPath, exchangeTx }) {
	const DPassive = await connectContract({
		network,
		deploymentPath,
		contractName: 'ProxyERC20',
		abiName: 'DPassive',
	});

	const logs = await getDecodedLogs({
		hash: exchangeTx.tx,
		contracts: [DPassive],
	});

	return logs.filter(log => log !== undefined);
}

async function exchangeSynths({
	network,
	deploymentPath,
	account,
	fromCurrency,
	toCurrency,
	amount,
	withTradingRewards = false,
}) {
	const DPassive = await connectContract({
		network,
		deploymentPath,
		contractName: 'ProxyERC20',
		abiName: 'DPassive',
	});

	const exchangeTx = await DPassive.exchange(
		toBytes32(fromCurrency),
		amount,
		toBytes32(toCurrency),
		{
			from: account,
		}
	);

	let exchangeLogs;
	if (withTradingRewards) {
		exchangeLogs = await getExchangeLogsWithTradingRewards({ network, deploymentPath, exchangeTx });
	} else {
		exchangeLogs = await getExchangeLogs({ network, deploymentPath, exchangeTx });
	}

	return { exchangeTx, exchangeLogs };
}

module.exports = {
	exchangeSynths,
};
