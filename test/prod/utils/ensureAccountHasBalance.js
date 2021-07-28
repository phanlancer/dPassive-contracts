const fs = require('fs');
const path = require('path');
const { connectContract } = require('./connectContract');
const { web3 } = require('hardhat');
const { toBN } = web3.utils;
const { knownAccounts, wrap, toBytes32 } = require('../../..');
const { gray } = require('chalk');

const knownMainnetAccount = knownAccounts['mainnet'].find(a => a.name === 'binance').address;

function getUser({ network, deploymentPath, user }) {
	const { getUsers } = wrap({ network, deploymentPath, fs, path });

	return getUsers({ user }).address;
}

async function ensureAccountHasEther({ network, deploymentPath, amount, account }) {
	const currentBalance = web3.utils.toBN(await web3.eth.getBalance(account));
	if (currentBalance.gte(amount)) {
		return;
	}

	console.log(gray(`    > Ensuring ${account} has Ether...`));

	const fromAccount =
		network === 'mainnet'
			? knownMainnetAccount
			: getUser({ network, deploymentPath, user: 'owner' });

	const balance = toBN(await web3.eth.getBalance(fromAccount));
	if (balance.lt(amount)) {
		throw new Error(
			`Account ${fromAccount} only has ${balance} ETH and cannot transfer ${amount} ETH to ${account} `
		);
	}

	await web3.eth.sendTransaction({
		from: fromAccount,
		to: account,
		value: amount,
	});
}

async function ensureAccountHasDPS({ network, deploymentPath, amount, account }) {
	const DPS = await connectContract({ network, deploymentPath, contractName: 'ProxyERC20' });
	if ((await DPS.balanceOf(account)).gte(amount)) {
		return;
	}

	console.log(gray(`    > Ensuring ${account} has DPS...`));

	const fromAccount =
		network === 'mainnet'
			? knownMainnetAccount
			: getUser({
					network,
					deploymentPath,
					user: 'owner',
			  });

	const balance = toBN(await DPS.balanceOf(fromAccount));
	if (balance.lt(amount)) {
		throw new Error(
			`Account ${fromAccount} only has ${balance} DPS and cannot transfer ${amount} DPS to ${account} `
		);
	}

	await DPS.transfer(account, amount, {
		from: fromAccount,
	});
}

async function ensureAccountHasdUSD({ network, deploymentPath, amount, account }) {
	const dUSD = await connectContract({
		network,
		deploymentPath,
		contractName: 'SynthdUSD',
		abiName: 'Synth',
	});
	if ((await dUSD.balanceOf(account)).gte(amount)) {
		return;
	}

	console.log(gray(`    > Ensuring ${account} has dUSD...`));

	const fromAccount =
		network === 'mainnet'
			? knownMainnetAccount
			: getUser({
					network,
					deploymentPath,
					user: 'owner',
			  });

	const balance = toBN(await dUSD.transferableSynths(fromAccount));
	const dpsToTransfer = amount.mul(toBN(30));
	if (balance.lt(amount)) {
		await ensureAccountHasDPS({
			network,
			deploymentPath,
			account,
			amount: dpsToTransfer,
		});

		const DPassive = await connectContract({
			network,
			deploymentPath,
			contractName: 'ProxyERC20',
			abiName: 'DPassive',
		});

		await DPassive.issueSynths(amount, {
			from: account,
		});
	} else {
		await dUSD.transferAndSettle(account, amount, { from: fromAccount });
	}
}

async function ensureAccountHasdETH({ network, deploymentPath, amount, account }) {
	const dETH = await connectContract({
		network,
		deploymentPath,
		contractName: 'SynthdETH',
		abiName: 'Synth',
	});
	if ((await dETH.balanceOf(account)).gte(amount)) {
		return;
	}

	console.log(gray(`    > Ensuring ${account} has dETH...`));

	const dUSDAmount = amount.mul(toBN('50'));
	await ensureAccountHasdUSD({ network, deploymentPath, amount: dUSDAmount, account });

	const DPassive = await connectContract({
		network,
		deploymentPath,
		contractName: 'ProxyERC20',
		abiName: 'DPassive',
	});

	await DPassive.exchange(toBytes32('dUSD'), dUSDAmount, toBytes32('dETH'), {
		from: account,
	});
}

module.exports = {
	ensureAccountHasEther,
	ensureAccountHasdUSD,
	ensureAccountHasdETH,
	ensureAccountHasDPS,
};
