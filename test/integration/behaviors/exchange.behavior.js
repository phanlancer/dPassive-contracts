const ethers = require('ethers');
const { assert } = require('../../contracts/common');
const { toBytes32 } = require('../../../index');
const { ensureBalance } = require('../utils/balances');

function itCanPerformExchanges({ ctx }) {
	const dUSDAmount = ethers.utils.parseEther('100');

	let owner;

	let DPassive, Exchanger, SynthdETH;

	before('target contracts and users', () => {
		({ DPassive, Exchanger, SynthdETH } = ctx.contracts);

		owner = ctx.owner;
	});

	before('ensure the owner has dUSD', async () => {
		await ensureBalance({ ctx, symbol: 'dUSD', user: owner, balance: dUSDAmount });
	});

	describe('when the owner exchanges from dUSD to dETH', () => {
		let balancedETH;

		before('record balances', async () => {
			balancedETH = await SynthdETH.balanceOf(owner.address);
		});

		before('perform the exchange', async () => {
			DPassive = DPassive.connect(owner);

			const tx = await DPassive.exchange(toBytes32('dUSD'), dUSDAmount, toBytes32('dETH'));
			await tx.wait();
		});

		it('receives the expected amount of dETH', async () => {
			const [expectedAmount, ,] = await Exchanger.getAmountsForExchange(
				dUSDAmount,
				toBytes32('dUSD'),
				toBytes32('dETH')
			);

			assert.bnEqual(await SynthdETH.balanceOf(owner.address), balancedETH.add(expectedAmount));
		});
	});
}

module.exports = {
	itCanPerformExchanges,
};
