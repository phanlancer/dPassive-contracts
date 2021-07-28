async function ensureBalance({ ctx, symbol, user, balance }) {
	const token = _getTokenFromSymbol({ ctx, symbol });
	const currentBalance = await token.balanceOf(user.address);

	if (currentBalance.lt(balance)) {
		const amount = balance.sub(currentBalance);

		await _getTokens({ ctx, symbol, user, amount });
	}
}

async function _getTokens({ ctx, symbol, user, amount }) {
	if (symbol === 'DPS') {
		await _getDPS({ ctx, user, amount });
	} else if (symbol === 'dUSD') {
		await _getdUSD({ ctx, user, amount });
	} else {
		// TODO: will need to get DPS and then exchange
	}
}

async function _getDPS({ ctx, user, amount }) {
	const DPassive = ctx.contracts.DPassive.connect(ctx.owner);

	const tx = await DPassive.transfer(user.address, amount);
	await tx.wait();
}

async function _getdUSD({ ctx, user, amount }) {
	const DPassive = ctx.contracts.DPassive.connect(ctx.owner);

	let tx;

	tx = await DPassive.issueSynths(amount);
	await tx.wait();

	tx = await DPassive.transfer(user.address, amount);
	await tx.wait();
}

function _getTokenFromSymbol({ ctx, symbol }) {
	if (symbol === 'DPS') {
		return ctx.contracts.DPassive;
	} else {
		return ctx.contracts[`Synth${symbol}`];
	}
}

module.exports = {
	ensureBalance,
};
