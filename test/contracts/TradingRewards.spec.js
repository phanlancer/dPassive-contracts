const { contract, web3 } = require('hardhat');
const { toBN } = web3.utils;
const { assert, addSnapshotBeforeRestoreAfter } = require('./common');
const { setupAllContracts } = require('./setup');
const { currentTime, toUnit, multiplyDecimal } = require('../utils')();
const { setExchangeFeeRateForSynths, getDecodedLogs, decodedEventEqual } = require('./helpers');
const { toBytes32 } = require('../..');

/*
 * This tests the TradingRewards contract's integration
 * with the rest of the DPassive system.
 *
 * Inner workings of the contract are tested in TradingRewards.unit.js.
 **/
contract('TradingRewards', accounts => {
	const [, owner, account1] = accounts;

	const synths = ['dUSD', 'dETH', 'dBTC'];
	const synthKeys = synths.map(toBytes32);
	const [dUSD, dETH, dBTC] = synthKeys;

	let dpassive, exchanger, exchangeRates, rewards, resolver, systemSettings;
	let dUSDContract, dETHContract, dBTCContract;

	let exchangeLogs;

	const zeroAddress = '0x0000000000000000000000000000000000000000';

	const amountIssued = toUnit('1000');
	const allExchangeFeeRates = toUnit('0.001');
	const rates = {
		[dETH]: toUnit('100'),
		[dBTC]: toUnit('12000'),
	};

	let feesPaidUSD;

	async function getExchangeLogs({ exchangeTx }) {
		const logs = await getDecodedLogs({
			hash: exchangeTx.tx,
			contracts: [dpassive, rewards],
		});

		return logs.filter(log => log !== undefined);
	}

	async function executeTrade({ account, fromCurrencyKey, fromCurrencyAmount, toCurrencyKey }) {
		const exchangeTx = await dpassive.exchange(fromCurrencyKey, fromCurrencyAmount, toCurrencyKey, {
			from: account,
		});

		const { fee } = await exchanger.getAmountsForExchange(
			fromCurrencyAmount,
			fromCurrencyKey,
			toCurrencyKey
		);

		const rate = rates[toCurrencyKey];
		feesPaidUSD = multiplyDecimal(fee, rate);

		exchangeLogs = await getExchangeLogs({ exchangeTx });
	}

	describe('when deploying the system', () => {
		before('deploy all contracts', async () => {
			({
				DPassive: dpassive,
				TradingRewards: rewards,
				AddressResolver: resolver,
				Exchanger: exchanger,
				ExchangeRates: exchangeRates,
				SynthdUSD: dUSDContract,
				SynthdETH: dETHContract,
				SynthdBTC: dBTCContract,
				SystemSettings: systemSettings,
			} = await setupAllContracts({
				accounts,
				synths,
				contracts: [
					'DPassive',
					'TradingRewards',
					'Exchanger',
					'AddressResolver',
					'ExchangeRates',
					'SystemSettings',
					'CollateralManager',
				],
			}));
		});

		before('BRRRRRR', async () => {
			await dUSDContract.issue(account1, amountIssued);
			await dETHContract.issue(account1, amountIssued);
			await dBTCContract.issue(account1, amountIssued);
		});

		before('set exchange rates', async () => {
			const oracle = account1;
			const timestamp = await currentTime();

			await exchangeRates.updateRates([dETH, dBTC], Object.values(rates), timestamp, {
				from: oracle,
			});

			await setExchangeFeeRateForSynths({
				owner,
				systemSettings,
				synthKeys,
				exchangeFeeRates: synthKeys.map(() => allExchangeFeeRates),
			});
		});

		it('has expected balances for accounts', async () => {
			assert.bnEqual(amountIssued, await dUSDContract.balanceOf(account1));
			assert.bnEqual(amountIssued, await dETHContract.balanceOf(account1));
			assert.bnEqual(amountIssued, await dBTCContract.balanceOf(account1));
		});

		it('has expected parameters', async () => {
			assert.equal(owner, await rewards.getPeriodController());
			assert.equal(owner, await rewards.owner());
			assert.equal(dpassive.address, await rewards.getRewardsToken());
			assert.equal(resolver.address, await rewards.resolver());
		});

		describe('when SystemSettings tradingRewardsEnabled is false', () => {
			it('tradingRewardsEnabled is false', async () => {
				assert.isFalse(await systemSettings.tradingRewardsEnabled());
				assert.isFalse(await exchanger.tradingRewardsEnabled());
			});

			describe('when performing an exchange', () => {
				addSnapshotBeforeRestoreAfter();

				before('perform an exchange and get tx logs', async () => {
					await executeTrade({
						account: account1,
						fromCurrencyKey: dUSD,
						fromCurrencyAmount: toUnit('100'),
						toCurrencyKey: dETH,
					});
				});

				it('emitted a SynthExchange event', async () => {
					assert.isTrue(exchangeLogs.some(log => log.name === 'SynthExchange'));
				});

				it('did not emit an ExchangeFeeRecorded event', async () => {
					assert.isFalse(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
				});

				it('did not record a fee in TradingRewards', async () => {
					assert.bnEqual(await rewards.getUnaccountedFeesForAccountForPeriod(account1, 0), toBN(0));
				});
			});
		});

		describe('when SystemSettings tradingRewardsEnabled is set to true', () => {
			before('set tradingRewardsEnabled to true', async () => {
				await systemSettings.setTradingRewardsEnabled(true, { from: owner });
			});

			it('tradingRewardsEnabled is true', async () => {
				assert.isTrue(await systemSettings.tradingRewardsEnabled());
				assert.isTrue(await exchanger.tradingRewardsEnabled());
			});

			const itCorrectlyPerformsAnExchange = ({
				account,
				fromCurrencyKey,
				fromCurrencyAmount,
				toCurrencyKey,
			}) => {
				describe('when performing a regular exchange', () => {
					addSnapshotBeforeRestoreAfter();

					before('perform an exchange and get tx logs', async () => {
						await executeTrade({
							account,
							fromCurrencyKey,
							fromCurrencyAmount,
							toCurrencyKey,
						});
					});

					it('emitted a SynthExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'SynthExchange'));
					});

					it('emitted an ExchangeFeeRecorded event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));

						const feeRecordLog = exchangeLogs.find(log => log.name === 'ExchangeFeeRecorded');
						decodedEventEqual({
							event: 'ExchangeFeeRecorded',
							log: feeRecordLog,
							emittedFrom: rewards.address,
							args: [account, feesPaidUSD, 0],
						});
					});

					it('recorded a fee in TradingRewards', async () => {
						assert.bnEqual(
							await rewards.getUnaccountedFeesForAccountForPeriod(account1, 0),
							feesPaidUSD
						);
					});
				});
			};

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: dUSD,
				fromCurrencyAmount: toUnit('100'),
				toCurrencyKey: dETH,
			});

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: dUSD,
				fromCurrencyAmount: toUnit('100'),
				toCurrencyKey: dBTC,
			});

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: dETH,
				fromCurrencyAmount: toUnit('10'),
				toCurrencyKey: dBTC,
			});

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: dBTC,
				fromCurrencyAmount: toUnit('1'),
				toCurrencyKey: dETH,
			});

			describe('when exchangeFeeRate is set to 0', () => {
				addSnapshotBeforeRestoreAfter();

				before('set fee rate', async () => {
					const zeroRate = toBN(0);

					await setExchangeFeeRateForSynths({
						owner,
						systemSettings,
						synthKeys,
						exchangeFeeRates: synthKeys.map(() => zeroRate),
					});
				});

				describe('when performing an exchange', () => {
					before('perform an exchange and get tx logs', async () => {
						await executeTrade({
							account: account1,
							fromCurrencyKey: dUSD,
							fromCurrencyAmount: toUnit('100'),
							toCurrencyKey: dETH,
						});
					});

					it('emitted a SynthExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'SynthExchange'));
					});

					it('did not emit an ExchangeFeeRecorded event', async () => {
						assert.isFalse(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
					});
				});
			});

			describe('when executing an exchange with tracking', () => {
				addSnapshotBeforeRestoreAfter();

				describe('when a valid originator address is passed', () => {
					before('execute exchange with tracking', async () => {
						const exchangeTx = await dpassive.exchangeWithTracking(
							dUSD,
							toUnit('100'),
							dETH,
							account1,
							toBytes32('1INCH'),
							{
								from: account1,
							}
						);

						exchangeLogs = await getExchangeLogs({ exchangeTx });
					});

					it('emitted a SynthExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'SynthExchange'));
					});

					it('emitted an ExchangeFeeRecorded event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
					});
				});

				describe('when no valid originator address is passed', () => {
					before('execute exchange with tracking', async () => {
						const exchangeTx = await dpassive.exchangeWithTracking(
							dUSD,
							toUnit('100'),
							dETH,
							zeroAddress, // No originator = 0x0
							toBytes32('1INCH'),
							{
								from: account1,
							}
						);

						exchangeLogs = await getExchangeLogs({ exchangeTx });
					});

					it('emitted a SynthExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'SynthExchange'));
					});

					it('did not emit an ExchangeFeeRecorded event', async () => {
						assert.isFalse(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
					});
				});
			});
		});
	});
});
