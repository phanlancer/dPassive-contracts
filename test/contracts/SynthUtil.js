'use strict';

const { contract } = require('hardhat');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const {
	toBytes32,
	constants: { ZERO_BYTES32 },
} = require('../..');
const { toUnit, currentTime } = require('../utils')();
const { setExchangeFeeRateForSynths } = require('./helpers');

const { setupAllContracts } = require('./setup');

contract('SynthUtil', accounts => {
	const [, ownerAccount, oracle, account2] = accounts;
	let synthUtil, dUSDContract, dpassive, exchangeRates, timestamp, systemSettings, debtCache;

	const [dUSD, dBTC, iBTC] = ['dUSD', 'dBTC', 'iBTC'].map(toBytes32);
	const synthKeys = [dUSD, dBTC, iBTC];
	const synthPrices = [toUnit('1'), toUnit('5000'), toUnit('5000')];

	before(async () => {
		({
			SynthUtil: synthUtil,
			SynthdUSD: dUSDContract,
			DPassive: dpassive,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			synths: ['dUSD', 'dBTC', 'iBTC'],
			contracts: [
				'SynthUtil',
				'DPassive',
				'Exchanger',
				'ExchangeRates',
				'ExchangeState',
				'FeePoolState',
				'FeePoolEternalStorage',
				'SystemSettings',
				'DebtCache',
				'Issuer',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral to read collateral
			],
		}));
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		timestamp = await currentTime();
		await exchangeRates.updateRates([dBTC, iBTC], ['5000', '5000'].map(toUnit), timestamp, {
			from: oracle,
		});
		await debtCache.takeDebtSnapshot();

		// set a 0% default exchange fee rate for test purpose
		const exchangeFeeRate = toUnit('0');
		await setExchangeFeeRateForSynths({
			owner: ownerAccount,
			systemSettings,
			synthKeys,
			exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
		});
	});

	describe('given an instance', () => {
		const dUSDMinted = toUnit('10000');
		const amountToExchange = toUnit('50');
		const dUSDAmount = toUnit('100');
		beforeEach(async () => {
			await dpassive.issueSynths(dUSDMinted, {
				from: ownerAccount,
			});
			await dUSDContract.transfer(account2, dUSDAmount, { from: ownerAccount });
			await dpassive.exchange(dUSD, amountToExchange, dBTC, { from: account2 });
		});
		describe('totalSynthsInKey', () => {
			it('should return the total balance of synths into the specified currency key', async () => {
				assert.bnEqual(await synthUtil.totalSynthsInKey(account2, dUSD), dUSDAmount);
			});
		});
		describe('synthsBalances', () => {
			it('should return the balance and its value in dUSD for every synth in the wallet', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(dUSD, amountToExchange, dBTC);
				assert.deepEqual(await synthUtil.synthsBalances(account2), [
					[dUSD, dBTC, iBTC],
					[toUnit('50'), effectiveValue, 0],
					[toUnit('50'), toUnit('50'), 0],
				]);
			});
		});
		describe('frozenSynths', () => {
			it('should not return any currency keys when no synths are frozen', async () => {
				assert.deepEqual(
					await synthUtil.frozenSynths(),
					synthKeys.map(synth => ZERO_BYTES32)
				);
			});
			it('should return currency keys of frozen synths', async () => {
				await exchangeRates.setInversePricing(
					iBTC,
					toUnit('100'),
					toUnit('150'),
					toUnit('90'),
					true,
					false,
					{
						from: ownerAccount,
					}
				);
				assert.deepEqual(
					await synthUtil.frozenSynths(),
					synthKeys.map(synth => (synth === iBTC ? iBTC : ZERO_BYTES32))
				);
			});
		});
		describe('synthsRates', () => {
			it('should return the correct synth rates', async () => {
				assert.deepEqual(await synthUtil.synthsRates(), [synthKeys, synthPrices]);
			});
		});
		describe('synthsTotalSupplies', () => {
			it('should return the correct synth total supplies', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(dUSD, amountToExchange, dBTC);
				assert.deepEqual(await synthUtil.synthsTotalSupplies(), [
					synthKeys,
					[dUSDMinted.sub(amountToExchange), effectiveValue, 0],
					[dUSDMinted.sub(amountToExchange), amountToExchange, 0],
				]);
			});
		});
	});
});
