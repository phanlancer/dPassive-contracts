'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { currentTime, fastForward, multiplyDecimal, divideDecimal, toUnit } = require('../utils')();

const { setupAllContracts } = require('./setup');

const {
	setExchangeFeeRateForSynths,
	getDecodedLogs,
	decodedEventEqual,
	timeIsClose,
	onlyGivenAddressCanInvoke,
	setStatus,
	convertToAggregatorPrice,
	updateRatesWithDefaults,
} = require('./helpers');

const {
	toBytes32,
	defaults: { WAITING_PERIOD_SECS, PRICE_DEVIATION_THRESHOLD_FACTOR },
} = require('../..');

const BN = require('bn.js');

const bnCloseVariance = '30';

const MockAggregator = artifacts.require('MockAggregatorV2V3');

contract('Exchanger (spec tests)', async accounts => {
	const [dUSD, dAUD, dEUR, DPS, dBTC, iBTC, dETH, iETH] = [
		'dUSD',
		'dAUD',
		'dEUR',
		'DPS',
		'dBTC',
		'iBTC',
		'dETH',
		'iETH',
	].map(toBytes32);

	const trackingCode = toBytes32('1INCH');

	const synthKeys = [dUSD, dAUD, dEUR, dBTC, iBTC, dETH, iETH];

	const [, owner, account1, account2, account3] = accounts;

	let dpassive,
		exchangeRates,
		feePool,
		delegateApprovals,
		dUSDContract,
		dAUDContract,
		dEURContract,
		dBTCContract,
		iBTCContract,
		dETHContract,
		oracle,
		timestamp,
		exchanger,
		exchangeState,
		exchangeFeeRate,
		amountIssued,
		systemSettings,
		systemStatus,
		resolver,
		debtCache,
		issuer,
		flexibleStorage;

	const itReadsTheWaitingPeriod = () => {
		describe('waitingPeriodSecs', () => {
			it('the default is configured correctly', async () => {
				// Note: this only tests the effectiveness of the setup script, not the deploy script,
				assert.equal(await exchanger.waitingPeriodSecs(), WAITING_PERIOD_SECS);
			});
			describe('given it is configured to 90', () => {
				beforeEach(async () => {
					await systemSettings.setWaitingPeriodSecs('90', { from: owner });
				});
				describe('and there is an exchange', () => {
					beforeEach(async () => {
						await dpassive.exchange(dUSD, toUnit('100'), dEUR, { from: account1 });
					});
					it('then the maxSecsLeftInWaitingPeriod is close to 90', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
						timeIsClose({ actual: maxSecs, expected: 90, variance: 2 });
					});
					describe('and 87 seconds elapses', () => {
						// Note: timestamp accurancy can't be guaranteed, so provide a few seconds of buffer either way
						beforeEach(async () => {
							await fastForward(87);
						});
						describe('when settle() is called', () => {
							it('then it reverts', async () => {
								await assert.revert(
									dpassive.settle(dEUR, { from: account1 }),
									'Cannot settle during waiting period'
								);
							});
							it('and the maxSecsLeftInWaitingPeriod is close to 1', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
								timeIsClose({ actual: maxSecs, expected: 1, variance: 2 });
							});
						});
						describe('when a further 5 seconds elapse', () => {
							beforeEach(async () => {
								await fastForward(5);
							});
							describe('when settle() is called', () => {
								it('it successed', async () => {
									await dpassive.settle(dEUR, { from: account1 });
								});
							});
						});
					});
				});
			});
		});
	};

	const itWhenTheWaitingPeriodIsZero = () => {
		describe('When the waiting period is set to 0', () => {
			let initialWaitingPeriod;

			beforeEach(async () => {
				initialWaitingPeriod = await systemSettings.waitingPeriodSecs();
				await systemSettings.setWaitingPeriodSecs('0', { from: owner });
			});

			it('is set correctly', async () => {
				assert.bnEqual(await systemSettings.waitingPeriodSecs(), '0');
			});

			describe('When exchanging', () => {
				const amountOfSrcExchanged = toUnit('10');

				beforeEach(async () => {
					await updateRatesWithDefaults({ exchangeRates, oracle, debtCache });
					await dUSDContract.issue(owner, toUnit('100'));
					await dpassive.exchange(dUSD, toUnit('10'), dETH, { from: owner });
				});

				it('creates no new entries', async () => {
					let { numEntries } = await exchanger.settlementOwing(owner, dETH);
					assert.bnEqual(numEntries, '0');
					numEntries = await exchangeState.getLengthOfEntries(owner, dETH);
					assert.bnEqual(numEntries, '0');
				});

				it('can exchange back without waiting', async () => {
					const { amountReceived } = await exchanger.getAmountsForExchange(
						amountOfSrcExchanged,
						dUSD,
						dETH
					);
					await dpassive.exchange(dETH, amountReceived, dUSD, { from: owner });
					assert.bnEqual(await dETHContract.balanceOf(owner), '0');
				});

				describe('When the waiting period is switched on again', () => {
					beforeEach(async () => {
						await systemSettings.setWaitingPeriodSecs(initialWaitingPeriod, { from: owner });
					});

					it('is set correctly', async () => {
						assert.bnEqual(await systemSettings.waitingPeriodSecs(), initialWaitingPeriod);
					});

					describe('a new exchange takes place', () => {
						let exchangeTransaction;

						beforeEach(async () => {
							await fastForward(await systemSettings.waitingPeriodSecs());
							exchangeTransaction = await dpassive.exchange(dUSD, amountOfSrcExchanged, dETH, {
								from: owner,
							});
						});

						it('creates a new entry', async () => {
							const { numEntries } = await exchanger.settlementOwing(owner, dETH);
							assert.bnEqual(numEntries, '1');
						});

						it('then it emits an ExchangeEntryAppended', async () => {
							const { amountReceived, exchangeFeeRate } = await exchanger.getAmountsForExchange(
								amountOfSrcExchanged,
								dUSD,
								dETH
							);
							const logs = await getDecodedLogs({
								hash: exchangeTransaction.tx,
								contracts: [dpassive, exchanger, dUSDContract, issuer, flexibleStorage, debtCache],
							});
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'ExchangeEntryAppended'),
								event: 'ExchangeEntryAppended',
								emittedFrom: exchanger.address,
								args: [
									owner,
									dUSD,
									amountOfSrcExchanged,
									dETH,
									amountReceived,
									exchangeFeeRate,
									new web3.utils.BN(1),
									new web3.utils.BN(2),
								],
							});
						});

						it('reverts if the user tries to settle before the waiting period has expired', async () => {
							await assert.revert(
								dpassive.settle(dETH, {
									from: owner,
								}),
								'Cannot settle during waiting period'
							);
						});

						describe('When the waiting period is set back to 0', () => {
							beforeEach(async () => {
								await systemSettings.setWaitingPeriodSecs('0', { from: owner });
							});

							it('there should be only one dETH entry', async () => {
								let numEntries = await exchangeState.getLengthOfEntries(owner, dETH);
								assert.bnEqual(numEntries, '1');
								numEntries = await exchangeState.getLengthOfEntries(owner, dEUR);
								assert.bnEqual(numEntries, '0');
							});

							describe('new trades take place', () => {
								beforeEach(async () => {
									// await fastForward(await systemSettings.waitingPeriodSecs());
									const sEthBalance = await dETHContract.balanceOf(owner);
									await dpassive.exchange(dETH, sEthBalance, dUSD, { from: owner });
									await dpassive.exchange(dUSD, toUnit('10'), dEUR, { from: owner });
								});

								it('should settle the pending exchanges and remove all entries', async () => {
									assert.bnEqual(await dETHContract.balanceOf(owner), '0');
									const { numEntries } = await exchanger.settlementOwing(owner, dETH);
									assert.bnEqual(numEntries, '0');
								});

								it('should not create any new entries', async () => {
									const { numEntries } = await exchanger.settlementOwing(owner, dEUR);
									assert.bnEqual(numEntries, '0');
								});
							});
						});
					});
				});
			});
		});
	};

	const itDeviatesCorrectly = () => {
		describe('priceDeviationThresholdFactor()', () => {
			it('the default is configured correctly', async () => {
				// Note: this only tests the effectiveness of the setup script, not the deploy script,
				assert.equal(
					await exchanger.priceDeviationThresholdFactor(),
					PRICE_DEVIATION_THRESHOLD_FACTOR
				);
			});
			describe('when a user exchanges into dETH over the default threshold factor', () => {
				beforeEach(async () => {
					await fastForward(10);
					// base rate of dETH is 100 from shared setup above
					await exchangeRates.updateRates([dETH], [toUnit('300')], await currentTime(), {
						from: oracle,
					});
					await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
				});
				it('then the synth is suspended', async () => {
					const { suspended, reason } = await systemStatus.synthSuspension(dETH);
					assert.ok(suspended);
					assert.equal(reason, '65');
				});
			});
			describe('when a user exchanges into dETH under the default threshold factor', () => {
				beforeEach(async () => {
					await fastForward(10);
					// base rate of dETH is 100 from shared setup above
					await exchangeRates.updateRates([dETH], [toUnit('33')], await currentTime(), {
						from: oracle,
					});
					await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
				});
				it('then the synth is suspended', async () => {
					const { suspended, reason } = await systemStatus.synthSuspension(dETH);
					assert.ok(suspended);
					assert.equal(reason, '65');
				});
			});
			describe('changing the factor works', () => {
				describe('when the factor is set to 3.1', () => {
					beforeEach(async () => {
						await systemSettings.setPriceDeviationThresholdFactor(toUnit('3.1'), { from: owner });
					});
					describe('when a user exchanges into dETH over the default threshold factor, but under the new one', () => {
						beforeEach(async () => {
							await fastForward(10);
							// base rate of dETH is 100 from shared setup above
							await exchangeRates.updateRates([dETH], [toUnit('300')], await currentTime(), {
								from: oracle,
							});
							await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
						});
						it('then the synth is not suspended', async () => {
							const { suspended, reason } = await systemStatus.synthSuspension(dETH);
							assert.ok(!suspended);
							assert.equal(reason, '0');
						});
					});
					describe('when a user exchanges into dETH under the default threshold factor, but under the new one', () => {
						beforeEach(async () => {
							await fastForward(10);
							// base rate of dETH is 100 from shared setup above
							await exchangeRates.updateRates([dETH], [toUnit('33')], await currentTime(), {
								from: oracle,
							});
							await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
						});
						it('then the synth is not suspended', async () => {
							const { suspended, reason } = await systemStatus.synthSuspension(dETH);
							assert.ok(!suspended);
							assert.equal(reason, '0');
						});
					});
				});
			});
		});
	};

	const itCalculatesMaxSecsLeft = () => {
		describe('maxSecsLeftInWaitingPeriod()', () => {
			describe('when the waiting period is configured to 60', () => {
				let waitingPeriodSecs;
				beforeEach(async () => {
					waitingPeriodSecs = '60';
					await systemSettings.setWaitingPeriodSecs(waitingPeriodSecs, { from: owner });
				});
				describe('when there are no exchanges', () => {
					it('then it returns 0', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
						assert.equal(maxSecs, '0', 'No seconds remaining for exchange');
					});
				});
				describe('when a user with dUSD has performed an exchange into dEUR', () => {
					beforeEach(async () => {
						await dpassive.exchange(dUSD, toUnit('100'), dEUR, { from: account1 });
					});
					it('reports hasWaitingPeriodOrSettlementOwing', async () => {
						assert.isTrue(await exchanger.hasWaitingPeriodOrSettlementOwing(account1, dEUR));
					});
					it('then fetching maxSecs for that user into dEUR returns 60', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
						timeIsClose({ actual: maxSecs, expected: 60, variance: 2 });
					});
					it('and fetching maxSecs for that user into the source synth returns 0', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dUSD);
						assert.equal(maxSecs, '0', 'No waiting period for src synth');
					});
					it('and fetching maxSecs for that user into other synths returns 0', async () => {
						let maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dBTC);
						assert.equal(maxSecs, '0', 'No waiting period for other synth dBTC');
						maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, iBTC);
						assert.equal(maxSecs, '0', 'No waiting period for other synth iBTC');
					});
					it('and fetching maxSec for other users into that synth are unaffected', async () => {
						let maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account2, dEUR);
						assert.equal(
							maxSecs,
							'0',
							'Other user: account2 has no waiting period on dest synth of account 1'
						);
						maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account2, dUSD);
						assert.equal(
							maxSecs,
							'0',
							'Other user: account2 has no waiting period on src synth of account 1'
						);
						maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account3, dEUR);
						assert.equal(
							maxSecs,
							'0',
							'Other user: account3 has no waiting period on dest synth of acccount 1'
						);
					});

					describe('when 55 seconds has elapsed', () => {
						beforeEach(async () => {
							await fastForward(55);
						});
						it('then it returns 5', async () => {
							const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
							timeIsClose({ actual: maxSecs, expected: 5, variance: 2 });
						});
						describe('when another user does the same exchange', () => {
							beforeEach(async () => {
								await dpassive.exchange(dUSD, toUnit('100'), dEUR, { from: account2 });
							});
							it('then it still returns 5 for the original user', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
								timeIsClose({ actual: maxSecs, expected: 5, variance: 3 });
							});
							it('and yet the new user has 60 secs', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account2, dEUR);
								timeIsClose({ actual: maxSecs, expected: 60, variance: 3 });
							});
						});
						describe('when another 5 seconds elapses', () => {
							beforeEach(async () => {
								await fastForward(5);
							});
							it('then it returns 0', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
								assert.equal(maxSecs, '0', 'No time left in waiting period');
							});
							describe('when another 10 seconds elapses', () => {
								beforeEach(async () => {
									await fastForward(10);
								});
								it('then it still returns 0', async () => {
									const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
									assert.equal(maxSecs, '0', 'No time left in waiting period');
								});
							});
						});
						describe('when the same user exchanges into the new synth', () => {
							beforeEach(async () => {
								await dpassive.exchange(dUSD, toUnit('100'), dEUR, { from: account1 });
							});
							it('then the secs remaining returns 60 again', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, dEUR);
								timeIsClose({ actual: maxSecs, expected: 60, variance: 2 });
							});
						});
					});
				});
			});
		});
	};

	const itCalculatesFeeRateForExchange = () => {
		describe('Given exchangeFeeRates are configured and when calling feeRateForExchange()', () => {
			it('for two long synths, returns the regular exchange fee', async () => {
				const actualFeeRate = await exchanger.feeRateForExchange(dEUR, dBTC);
				assert.bnEqual(actualFeeRate, exchangeFeeRate, 'Rate must be the exchange fee rate');
			});
			it('for two inverse synths, returns the regular exchange fee', async () => {
				const actualFeeRate = await exchanger.feeRateForExchange(iBTC, iETH);
				assert.bnEqual(actualFeeRate, exchangeFeeRate, 'Rate must be the exchange fee rate');
			});
			it('for an inverse synth and dUSD, returns the regular exchange fee', async () => {
				let actualFeeRate = await exchanger.feeRateForExchange(iBTC, dUSD);
				assert.bnEqual(actualFeeRate, exchangeFeeRate, 'Rate must be the exchange fee rate');

				actualFeeRate = await exchanger.feeRateForExchange(dUSD, iBTC);
				assert.bnEqual(actualFeeRate, exchangeFeeRate, 'Rate must be the exchange fee rate');
			});
			it('for an inverse synth and a long synth, returns double the regular exchange fee', async () => {
				let actualFeeRate = await exchanger.feeRateForExchange(iBTC, dEUR);
				assert.bnEqual(
					actualFeeRate,
					exchangeFeeRate.mul(new BN(2)),
					'Rate must be the exchange fee rate'
				);
				actualFeeRate = await exchanger.feeRateForExchange(dEUR, iBTC);
				assert.bnEqual(
					actualFeeRate,
					exchangeFeeRate.mul(new BN(2)),
					'Rate must be the exchange fee rate'
				);
				actualFeeRate = await exchanger.feeRateForExchange(dBTC, iBTC);
				assert.bnEqual(
					actualFeeRate,
					exchangeFeeRate.mul(new BN(2)),
					'Rate must be the exchange fee rate'
				);
				actualFeeRate = await exchanger.feeRateForExchange(iBTC, dBTC);
				assert.bnEqual(
					actualFeeRate,
					exchangeFeeRate.mul(new BN(2)),
					'Rate must be the exchange fee rate'
				);
			});
		});
	};

	const itCalculatesFeeRateForExchange2 = () => {
		describe('given exchange fee rates are configured into categories', () => {
			const bipsFX = toUnit('0.01');
			const bipsCrypto = toUnit('0.02');
			const bipsInverse = toUnit('0.03');
			beforeEach(async () => {
				await systemSettings.setExchangeFeeRateForSynths(
					[dAUD, dEUR, dETH, dBTC, iBTC],
					[bipsFX, bipsFX, bipsCrypto, bipsCrypto, bipsInverse],
					{
						from: owner,
					}
				);
			});
			describe('when calling getAmountsForExchange', () => {
				describe('and the destination is a crypto synth', () => {
					let received;
					let destinationFee;
					let feeRate;
					beforeEach(async () => {
						await dpassive.exchange(dUSD, amountIssued, dBTC, { from: account1 });
						const { amountReceived, fee, exchangeFeeRate } = await exchanger.getAmountsForExchange(
							amountIssued,
							dUSD,
							dBTC
						);
						received = amountReceived;
						destinationFee = fee;
						feeRate = exchangeFeeRate;
					});
					it('then return the amountReceived', async () => {
						const dBTCBalance = await dBTCContract.balanceOf(account1);
						assert.bnEqual(received, dBTCBalance);
					});
					it('then return the fee', async () => {
						const effectiveValue = await exchangeRates.effectiveValue(dUSD, amountIssued, dBTC);
						assert.bnEqual(destinationFee, exchangeFeeIncurred(effectiveValue, bipsCrypto));
					});
					it('then return the feeRate', async () => {
						const exchangeFeeRate = await exchanger.feeRateForExchange(dUSD, dBTC);
						assert.bnEqual(feeRate, exchangeFeeRate);
					});
				});

				describe('and the destination is a fiat synth', () => {
					let received;
					let destinationFee;
					let feeRate;
					beforeEach(async () => {
						await dpassive.exchange(dUSD, amountIssued, dEUR, { from: account1 });
						const { amountReceived, fee, exchangeFeeRate } = await exchanger.getAmountsForExchange(
							amountIssued,
							dUSD,
							dEUR
						);
						received = amountReceived;
						destinationFee = fee;
						feeRate = exchangeFeeRate;
					});
					it('then return the amountReceived', async () => {
						const dEURBalance = await dEURContract.balanceOf(account1);
						assert.bnEqual(received, dEURBalance);
					});
					it('then return the fee', async () => {
						const effectiveValue = await exchangeRates.effectiveValue(dUSD, amountIssued, dEUR);
						assert.bnEqual(destinationFee, exchangeFeeIncurred(effectiveValue, bipsFX));
					});
					it('then return the feeRate', async () => {
						const exchangeFeeRate = await exchanger.feeRateForExchange(dUSD, dEUR);
						assert.bnEqual(feeRate, exchangeFeeRate);
					});
				});

				describe('and the destination is an inverse synth', () => {
					let received;
					let destinationFee;
					let feeRate;
					beforeEach(async () => {
						await dpassive.exchange(dUSD, amountIssued, iBTC, { from: account1 });
						const { amountReceived, fee, exchangeFeeRate } = await exchanger.getAmountsForExchange(
							amountIssued,
							dUSD,
							iBTC
						);
						received = amountReceived;
						destinationFee = fee;
						feeRate = exchangeFeeRate;
					});
					it('then return the amountReceived', async () => {
						const iBTCBalance = await iBTCContract.balanceOf(account1);
						assert.bnEqual(received, iBTCBalance);
					});
					it('then return the fee', async () => {
						const effectiveValue = await exchangeRates.effectiveValue(dUSD, amountIssued, iBTC);
						assert.bnEqual(destinationFee, exchangeFeeIncurred(effectiveValue, bipsInverse));
					});
					it('then return the feeRate', async () => {
						const exchangeFeeRate = await exchanger.feeRateForExchange(dUSD, iBTC);
						assert.bnEqual(feeRate, exchangeFeeRate);
					});
				});

				describe('when tripling an exchange rate', () => {
					const amount = toUnit('1000');
					const factor = toUnit('3');

					let orgininalFee;
					let orginalFeeRate;
					beforeEach(async () => {
						const { fee, exchangeFeeRate } = await exchanger.getAmountsForExchange(
							amount,
							dUSD,
							dAUD
						);
						orgininalFee = fee;
						orginalFeeRate = exchangeFeeRate;

						await systemSettings.setExchangeFeeRateForSynths(
							[dAUD],
							[multiplyDecimal(bipsFX, factor)],
							{
								from: owner,
							}
						);
					});
					it('then return the fee tripled', async () => {
						const { fee } = await exchanger.getAmountsForExchange(amount, dUSD, dAUD);
						assert.bnEqual(fee, multiplyDecimal(orgininalFee, factor));
					});
					it('then return the feeRate tripled', async () => {
						const { exchangeFeeRate } = await exchanger.getAmountsForExchange(amount, dUSD, dAUD);
						assert.bnEqual(exchangeFeeRate, multiplyDecimal(orginalFeeRate, factor));
					});
					it('then return the amountReceived less triple the fee', async () => {
						const { amountReceived } = await exchanger.getAmountsForExchange(amount, dUSD, dAUD);
						const tripleFee = multiplyDecimal(orgininalFee, factor);
						const effectiveValue = await exchangeRates.effectiveValue(dUSD, amount, dAUD);
						assert.bnEqual(amountReceived, effectiveValue.sub(tripleFee));
					});
				});
			});
		});
	};

	const exchangeFeeIncurred = (amountToExchange, exchangeFeeRate) => {
		return multiplyDecimal(amountToExchange, exchangeFeeRate);
	};

	const amountAfterExchangeFee = ({ amount }) => {
		return multiplyDecimal(amount, toUnit('1').sub(exchangeFeeRate));
	};

	const calculateExpectedSettlementAmount = ({ amount, oldRate, newRate }) => {
		// Note: exchangeFeeRate is in a parent scope. Tests may mutate it in beforeEach and
		// be assured that this function, when called in a test, will use that mutated value
		const result = multiplyDecimal(amountAfterExchangeFee({ amount }), oldRate.sub(newRate));
		return {
			reclaimAmount: result.isNeg() ? new web3.utils.BN(0) : result,
			rebateAmount: result.isNeg() ? result.abs() : new web3.utils.BN(0),
		};
	};

	/**
	 * Ensure a settle() transaction emits the expected events
	 */
	const ensureTxnEmitsSettlementEvents = async ({ hash, synth, expected }) => {
		// Get receipt to collect all transaction events
		const logs = await getDecodedLogs({ hash, contracts: [dpassive, exchanger, dUSDContract] });

		const currencyKey = await synth.currencyKey();
		// Can only either be reclaim or rebate - not both
		const isReclaim = !expected.reclaimAmount.isZero();
		const expectedAmount = isReclaim ? expected.reclaimAmount : expected.rebateAmount;

		const eventName = `Exchange${isReclaim ? 'Reclaim' : 'Rebate'}`;
		decodedEventEqual({
			log: logs.find(({ name }) => name === eventName), // logs[0] is individual reclaim/rebate events, logs[1] is either an Issued or Burned event
			event: eventName,
			emittedFrom: await dpassive.proxy(),
			args: [account1, currencyKey, expectedAmount],
			bnCloseVariance,
		});

		// return all logs for any other usage
		return logs;
	};

	const itSettles = () => {
		describe('settlement', () => {
			describe('suspension conditions', () => {
				const synth = dETH;
				['System', 'Synth'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true, synth });
						});
						it('then calling settle() reverts', async () => {
							await assert.revert(
								dpassive.settle(dETH, { from: account1 }),
								'Operation prohibited'
							);
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false, synth });
							});
							it('then calling exchange() succeeds', async () => {
								await dpassive.settle(dETH, { from: account1 });
							});
						});
					});
				});
				describe('when Synth(dBTC) is suspended', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section: 'Synth', suspend: true, synth: dBTC });
					});
					it('then settling other synths still works', async () => {
						await dpassive.settle(dETH, { from: account1 });
						await dpassive.settle(dAUD, { from: account2 });
					});
				});
				describe('when Synth(dBTC) is suspended for exchanging', () => {
					beforeEach(async () => {
						await setStatus({
							owner,
							systemStatus,
							section: 'SynthExchange',
							suspend: true,
							synth: dBTC,
						});
					});
					it('then settling it still works', async () => {
						await dpassive.settle(dBTC, { from: account1 });
					});
				});
			});
			describe('given the dEUR rate is 2, and dETH is 100, dBTC is 9000', () => {
				beforeEach(async () => {
					// set dUSD:dEUR as 2:1, dUSD:dETH at 100:1, dUSD:dBTC at 9000:1
					await exchangeRates.updateRates(
						[dEUR, dETH, dBTC],
						['2', '100', '9000'].map(toUnit),
						timestamp,
						{
							from: oracle,
						}
					);
				});
				describe('and the exchange fee rate is 1% for easier human consumption', () => {
					beforeEach(async () => {
						// Warning: this is mutating the global exchangeFeeRate for this test block and will be reset when out of scope
						exchangeFeeRate = toUnit('0.01');
						await setExchangeFeeRateForSynths({
							owner,
							systemSettings,
							synthKeys,
							exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
						});
					});
					describe('and the waitingPeriodSecs is set to 60', () => {
						beforeEach(async () => {
							await systemSettings.setWaitingPeriodSecs('60', { from: owner });
						});
						describe('various rebate & reclaim scenarios', () => {
							describe('and the priceDeviationThresholdFactor is set to a factor of 2.5', () => {
								beforeEach(async () => {
									// prevent circuit breaker from firing for doubling or halving rates by upping the threshold difference to 2.5
									await systemSettings.setPriceDeviationThresholdFactor(toUnit('2.5'), {
										from: owner,
									});
								});
								describe('when the first user exchanges 100 dUSD into dUSD:dEUR at 2:1', () => {
									let amountOfSrcExchanged;
									let exchangeTime;
									let exchangeTransaction;
									beforeEach(async () => {
										amountOfSrcExchanged = toUnit('100');
										exchangeTime = await currentTime();
										exchangeTransaction = await dpassive.exchange(
											dUSD,
											amountOfSrcExchanged,
											dEUR,
											{
												from: account1,
											}
										);

										const {
											amountReceived,
											exchangeFeeRate,
										} = await exchanger.getAmountsForExchange(amountOfSrcExchanged, dUSD, dEUR);

										const logs = await getDecodedLogs({
											hash: exchangeTransaction.tx,
											contracts: [
												dpassive,
												exchanger,
												dUSDContract,
												issuer,
												flexibleStorage,
												debtCache,
											],
										});

										// ExchangeEntryAppended is emitted for exchange
										decodedEventEqual({
											log: logs.find(({ name }) => name === 'ExchangeEntryAppended'),
											event: 'ExchangeEntryAppended',
											emittedFrom: exchanger.address,
											args: [
												account1,
												dUSD,
												amountOfSrcExchanged,
												dEUR,
												amountReceived,
												exchangeFeeRate,
												new web3.utils.BN(1),
												new web3.utils.BN(2),
											],
											bnCloseVariance,
										});
									});
									it('then settlement reclaimAmount shows 0 reclaim and 0 refund', async () => {
										const settlement = await exchanger.settlementOwing(account1, dEUR);
										assert.equal(settlement.reclaimAmount, '0', 'Nothing can be reclaimAmount');
										assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
										assert.equal(
											settlement.numEntries,
											'1',
											'Must be one entry in the settlement queue'
										);
									});
									describe('when settle() is invoked on dEUR', () => {
										it('then it reverts as the waiting period has not ended', async () => {
											await assert.revert(
												dpassive.settle(dEUR, { from: account1 }),
												'Cannot settle during waiting period'
											);
										});
									});
									it('when dEUR is attempted to be exchanged away by the user, it reverts', async () => {
										await assert.revert(
											dpassive.exchange(dEUR, toUnit('1'), dBTC, { from: account1 }),
											'Cannot settle during waiting period'
										);
									});

									describe('when settle() is invoked on the src synth - dUSD', () => {
										it('then it completes with no reclaim or rebate', async () => {
											const txn = await dpassive.settle(dUSD, {
												from: account1,
											});
											assert.equal(
												txn.logs.length,
												0,
												'Must not emit any events as no settlement required'
											);
										});
									});
									describe('when settle() is invoked on dEUR by another user', () => {
										it('then it completes with no reclaim or rebate', async () => {
											const txn = await dpassive.settle(dEUR, {
												from: account2,
											});
											assert.equal(
												txn.logs.length,
												0,
												'Must not emit any events as no settlement required'
											);
										});
									});
									describe('when the price doubles for dUSD:dEUR to 4:1', () => {
										beforeEach(async () => {
											await fastForward(5);
											timestamp = await currentTime();

											await exchangeRates.updateRates([dEUR], ['4'].map(toUnit), timestamp, {
												from: oracle,
											});
										});
										it('then settlement reclaimAmount shows a reclaim of half the entire balance of dEUR', async () => {
											const expected = calculateExpectedSettlementAmount({
												amount: amountOfSrcExchanged,
												oldRate: divideDecimal(1, 2),
												newRate: divideDecimal(1, 4),
											});

											const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
												account1,
												dEUR
											);

											assert.bnEqual(rebateAmount, expected.rebateAmount);
											assert.bnEqual(reclaimAmount, expected.reclaimAmount);
										});
										describe('when settle() is invoked', () => {
											it('then it reverts as the waiting period has not ended', async () => {
												await assert.revert(
													dpassive.settle(dEUR, { from: account1 }),
													'Cannot settle during waiting period'
												);
											});
										});
										describe('when another minute passes', () => {
											let expectedSettlement;
											let srcBalanceBeforeExchange;

											beforeEach(async () => {
												await fastForward(60);
												srcBalanceBeforeExchange = await dEURContract.balanceOf(account1);

												expectedSettlement = calculateExpectedSettlementAmount({
													amount: amountOfSrcExchanged,
													oldRate: divideDecimal(1, 2),
													newRate: divideDecimal(1, 4),
												});
											});
											describe('when settle() is invoked', () => {
												let transaction;
												beforeEach(async () => {
													transaction = await dpassive.settle(dEUR, {
														from: account1,
													});
												});
												it('then it settles with a reclaim', async () => {
													await ensureTxnEmitsSettlementEvents({
														hash: transaction.tx,
														synth: dEURContract,
														expected: expectedSettlement,
													});
												});
												it('then it settles with a ExchangeEntrySettled event with reclaim', async () => {
													const logs = await getDecodedLogs({
														hash: transaction.tx,
														contracts: [dpassive, exchanger, dUSDContract],
													});

													decodedEventEqual({
														log: logs.find(({ name }) => name === 'ExchangeEntrySettled'),
														event: 'ExchangeEntrySettled',
														emittedFrom: exchanger.address,
														args: [
															account1,
															dUSD,
															amountOfSrcExchanged,
															dEUR,
															expectedSettlement.reclaimAmount,
															new web3.utils.BN(0),
															new web3.utils.BN(1),
															new web3.utils.BN(3),
															exchangeTime + 1,
														],
														bnCloseVariance,
													});
												});
											});
											describe('when settle() is invoked and the exchange fee rate has changed', () => {
												beforeEach(async () => {
													systemSettings.setExchangeFeeRateForSynths([dBTC], [toUnit('0.1')], {
														from: owner,
													});
												});
												it('then it settles with a reclaim', async () => {
													const { tx: hash } = await dpassive.settle(dEUR, {
														from: account1,
													});
													await ensureTxnEmitsSettlementEvents({
														hash,
														synth: dEURContract,
														expected: expectedSettlement,
													});
												});
											});

											// The user has ~49.5 dEUR and has a reclaim of ~24.75 - so 24.75 after settlement
											describe(
												'when an exchange out of dEUR for more than the balance after settlement,' +
													'but less than the total initially',
												() => {
													let txn;
													beforeEach(async () => {
														txn = await dpassive.exchange(dEUR, toUnit('30'), dBTC, {
															from: account1,
														});
													});
													it('then it succeeds, exchanging the entire amount after settlement', async () => {
														const srcBalanceAfterExchange = await dEURContract.balanceOf(account1);
														assert.equal(srcBalanceAfterExchange, '0');

														const decodedLogs = await ensureTxnEmitsSettlementEvents({
															hash: txn.tx,
															synth: dEURContract,
															expected: expectedSettlement,
														});

														decodedEventEqual({
															log: decodedLogs.find(({ name }) => name === 'SynthExchange'),
															event: 'SynthExchange',
															emittedFrom: await dpassive.proxy(),
															args: [
																account1,
																dEUR,
																srcBalanceBeforeExchange.sub(expectedSettlement.reclaimAmount),
																dBTC,
															],
														});
													});
												}
											);

											describe(
												'when an exchange out of dEUR for more than the balance after settlement,' +
													'and more than the total initially and the exchangefee rate changed',
												() => {
													let txn;
													beforeEach(async () => {
														txn = await dpassive.exchange(dEUR, toUnit('50'), dBTC, {
															from: account1,
														});
														systemSettings.setExchangeFeeRateForSynths([dBTC], [toUnit('0.1')], {
															from: owner,
														});
													});
													it('then it succeeds, exchanging the entire amount after settlement', async () => {
														const srcBalanceAfterExchange = await dEURContract.balanceOf(account1);
														assert.equal(srcBalanceAfterExchange, '0');

														const decodedLogs = await ensureTxnEmitsSettlementEvents({
															hash: txn.tx,
															synth: dEURContract,
															expected: expectedSettlement,
														});

														decodedEventEqual({
															log: decodedLogs.find(({ name }) => name === 'SynthExchange'),
															event: 'SynthExchange',
															emittedFrom: await dpassive.proxy(),
															args: [
																account1,
																dEUR,
																srcBalanceBeforeExchange.sub(expectedSettlement.reclaimAmount),
																dBTC,
															],
														});
													});
												}
											);

											describe('when an exchange out of dEUR for less than the balance after settlement', () => {
												let newAmountToExchange;
												let txn;
												beforeEach(async () => {
													newAmountToExchange = toUnit('10');
													txn = await dpassive.exchange(dEUR, newAmountToExchange, dBTC, {
														from: account1,
													});
												});
												it('then it succeeds, exchanging the amount given', async () => {
													const srcBalanceAfterExchange = await dEURContract.balanceOf(account1);

													assert.bnClose(
														srcBalanceAfterExchange,
														srcBalanceBeforeExchange
															.sub(expectedSettlement.reclaimAmount)
															.sub(newAmountToExchange)
													);

													const decodedLogs = await ensureTxnEmitsSettlementEvents({
														hash: txn.tx,
														synth: dEURContract,
														expected: expectedSettlement,
													});

													decodedEventEqual({
														log: decodedLogs.find(({ name }) => name === 'SynthExchange'),
														event: 'SynthExchange',
														emittedFrom: await dpassive.proxy(),
														args: [account1, dEUR, newAmountToExchange, dBTC], // amount to exchange must be the reclaim amount
													});
												});
											});
										});
									});
									describe('when the price halves for dUSD:dEUR to 1:1', () => {
										beforeEach(async () => {
											await fastForward(5);

											timestamp = await currentTime();

											await exchangeRates.updateRates([dEUR], ['1'].map(toUnit), timestamp, {
												from: oracle,
											});
										});
										it('then settlement rebateAmount shows a rebate of half the entire balance of dEUR', async () => {
											const expected = calculateExpectedSettlementAmount({
												amount: amountOfSrcExchanged,
												oldRate: divideDecimal(1, 2),
												newRate: divideDecimal(1, 1),
											});

											const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
												account1,
												dEUR
											);

											assert.bnEqual(rebateAmount, expected.rebateAmount);
											assert.bnEqual(reclaimAmount, expected.reclaimAmount);
										});
										describe('when the user makes a 2nd exchange of 100 dUSD into dUSD:dEUR at 1:1', () => {
											beforeEach(async () => {
												// fast forward 60 seconds so 1st exchange is using first rate
												await fastForward(60);

												await dpassive.exchange(dUSD, amountOfSrcExchanged, dEUR, {
													from: account1,
												});
											});
											describe('and then the price increases for dUSD:dEUR to 2:1', () => {
												beforeEach(async () => {
													await fastForward(5);

													timestamp = await currentTime();

													await exchangeRates.updateRates([dEUR], ['2'].map(toUnit), timestamp, {
														from: oracle,
													});
												});
												describe('when settlement is invoked', () => {
													describe('when another minute passes', () => {
														let expectedSettlementReclaim;
														let expectedSettlementRebate;
														beforeEach(async () => {
															await fastForward(60);

															expectedSettlementRebate = calculateExpectedSettlementAmount({
																amount: amountOfSrcExchanged,
																oldRate: divideDecimal(1, 2),
																newRate: divideDecimal(1, 1),
															});

															expectedSettlementReclaim = calculateExpectedSettlementAmount({
																amount: amountOfSrcExchanged,
																oldRate: divideDecimal(1, 1),
																newRate: divideDecimal(1, 2),
															});
														});

														describe('when settle() is invoked', () => {
															let transaction;
															beforeEach(async () => {
																transaction = await dpassive.settle(dEUR, {
																	from: account1,
																});
															});
															it('then it settles with two ExchangeEntrySettled events one for reclaim and one for rebate', async () => {
																const logs = await getDecodedLogs({
																	hash: transaction.tx,
																	contracts: [dpassive, exchanger, dUSDContract],
																});

																// check the rebate event first
																decodedEventEqual({
																	log: logs.filter(
																		({ name }) => name === 'ExchangeEntrySettled'
																	)[0],
																	event: 'ExchangeEntrySettled',
																	emittedFrom: exchanger.address,
																	args: [
																		account1,
																		dUSD,
																		amountOfSrcExchanged,
																		dEUR,
																		new web3.utils.BN(0),
																		expectedSettlementRebate.rebateAmount,
																		new web3.utils.BN(1),
																		new web3.utils.BN(2),
																		exchangeTime + 1,
																	],
																	bnCloseVariance,
																});

																// check the reclaim event
																decodedEventEqual({
																	log: logs.filter(
																		({ name }) => name === 'ExchangeEntrySettled'
																	)[1],
																	event: 'ExchangeEntrySettled',
																	emittedFrom: exchanger.address,
																	args: [
																		account1,
																		dUSD,
																		amountOfSrcExchanged,
																		dEUR,
																		expectedSettlementReclaim.reclaimAmount,
																		new web3.utils.BN(0),
																		new web3.utils.BN(1),
																		new web3.utils.BN(2),
																	],
																	bnCloseVariance,
																});
															});
														});
													});
												});
											});
										});
										describe('when settlement is invoked', () => {
											it('then it reverts as the waiting period has not ended', async () => {
												await assert.revert(
													dpassive.settle(dEUR, { from: account1 }),
													'Cannot settle during waiting period'
												);
											});
											describe('when another minute passes', () => {
												let expectedSettlement;
												let srcBalanceBeforeExchange;

												beforeEach(async () => {
													await fastForward(60);
													srcBalanceBeforeExchange = await dEURContract.balanceOf(account1);

													expectedSettlement = calculateExpectedSettlementAmount({
														amount: amountOfSrcExchanged,
														oldRate: divideDecimal(1, 2),
														newRate: divideDecimal(1, 1),
													});
												});

												describe('when settle() is invoked', () => {
													let transaction;
													beforeEach(async () => {
														transaction = await dpassive.settle(dEUR, {
															from: account1,
														});
													});
													it('then it settles with a rebate', async () => {
														await ensureTxnEmitsSettlementEvents({
															hash: transaction.tx,
															synth: dEURContract,
															expected: expectedSettlement,
														});
													});
													it('then it settles with a ExchangeEntrySettled event with rebate', async () => {
														const logs = await getDecodedLogs({
															hash: transaction.tx,
															contracts: [dpassive, exchanger, dUSDContract],
														});

														decodedEventEqual({
															log: logs.find(({ name }) => name === 'ExchangeEntrySettled'),
															event: 'ExchangeEntrySettled',
															emittedFrom: exchanger.address,
															args: [
																account1,
																dUSD,
																amountOfSrcExchanged,
																dEUR,
																new web3.utils.BN(0),
																expectedSettlement.rebateAmount,
																new web3.utils.BN(1),
																new web3.utils.BN(2),
																exchangeTime + 1,
															],
															bnCloseVariance,
														});
													});
												});

												// The user has 49.5 dEUR and has a rebate of 49.5 - so 99 after settlement
												describe('when an exchange out of dEUR for their expected balance before exchange', () => {
													let txn;
													beforeEach(async () => {
														txn = await dpassive.exchange(dEUR, toUnit('49.5'), dBTC, {
															from: account1,
														});
													});
													it('then it succeeds, exchanging the entire amount plus the rebate', async () => {
														const srcBalanceAfterExchange = await dEURContract.balanceOf(account1);
														assert.equal(srcBalanceAfterExchange, '0');

														const decodedLogs = await ensureTxnEmitsSettlementEvents({
															hash: txn.tx,
															synth: dEURContract,
															expected: expectedSettlement,
														});

														decodedEventEqual({
															log: decodedLogs.find(({ name }) => name === 'SynthExchange'),
															event: 'SynthExchange',
															emittedFrom: await dpassive.proxy(),
															args: [
																account1,
																dEUR,
																srcBalanceBeforeExchange.add(expectedSettlement.rebateAmount),
																dBTC,
															],
														});
													});
												});

												describe('when an exchange out of dEUR for some amount less than their balance before exchange', () => {
													let txn;
													beforeEach(async () => {
														txn = await dpassive.exchange(dEUR, toUnit('10'), dBTC, {
															from: account1,
														});
													});
													it('then it succeeds, exchanging the amount plus the rebate', async () => {
														const decodedLogs = await ensureTxnEmitsSettlementEvents({
															hash: txn.tx,
															synth: dEURContract,
															expected: expectedSettlement,
														});

														decodedEventEqual({
															log: decodedLogs.find(({ name }) => name === 'SynthExchange'),
															event: 'SynthExchange',
															emittedFrom: await dpassive.proxy(),
															args: [
																account1,
																dEUR,
																toUnit('10').add(expectedSettlement.rebateAmount),
																dBTC,
															],
														});
													});
												});
											});
										});
										describe('when the price returns to dUSD:dEUR to 2:1', () => {
											beforeEach(async () => {
												await fastForward(12);

												timestamp = await currentTime();

												await exchangeRates.updateRates([dEUR], ['2'].map(toUnit), timestamp, {
													from: oracle,
												});
											});
											it('then settlement reclaimAmount shows 0 reclaim and 0 refund', async () => {
												const settlement = await exchanger.settlementOwing(account1, dEUR);
												assert.equal(settlement.reclaimAmount, '0', 'Nothing can be reclaimAmount');
												assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
											});
											describe('when another minute elapses and the dETH price changes', () => {
												beforeEach(async () => {
													await fastForward(60);
													timestamp = await currentTime();

													await exchangeRates.updateRates([dEUR], ['3'].map(toUnit), timestamp, {
														from: oracle,
													});
												});
												it('then settlement reclaimAmount still shows 0 reclaim and 0 refund as the timeout period ended', async () => {
													const settlement = await exchanger.settlementOwing(account1, dEUR);
													assert.equal(
														settlement.reclaimAmount,
														'0',
														'Nothing can be reclaimAmount'
													);
													assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
												});
												describe('when settle() is invoked', () => {
													it('then it settles with no reclaim or rebate', async () => {
														const txn = await dpassive.settle(dEUR, {
															from: account1,
														});
														assert.equal(
															txn.logs.length,
															0,
															'Must not emit any events as no settlement required'
														);
													});
												});
											});
										});
									});
								});
								describe('given the first user has 1000 dEUR', () => {
									beforeEach(async () => {
										await dEURContract.issue(account1, toUnit('1000'));
									});
									describe('when the first user exchanges 100 dEUR into dEUR:dBTC at 9000:2', () => {
										let amountOfSrcExchanged;
										beforeEach(async () => {
											amountOfSrcExchanged = toUnit('100');
											await dpassive.exchange(dEUR, amountOfSrcExchanged, dBTC, {
												from: account1,
											});
										});
										it('then settlement reclaimAmount shows 0 reclaim and 0 refund', async () => {
											const settlement = await exchanger.settlementOwing(account1, dBTC);
											assert.equal(settlement.reclaimAmount, '0', 'Nothing can be reclaimAmount');
											assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
											assert.equal(
												settlement.numEntries,
												'1',
												'Must be one entry in the settlement queue'
											);
										});
										describe('when the price doubles for dUSD:dEUR to 4:1', () => {
											beforeEach(async () => {
												await fastForward(5);
												timestamp = await currentTime();

												await exchangeRates.updateRates([dEUR], ['4'].map(toUnit), timestamp, {
													from: oracle,
												});
											});
											it('then settlement shows a rebate rebateAmount', async () => {
												const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
													account1,
													dBTC
												);

												const expected = calculateExpectedSettlementAmount({
													amount: amountOfSrcExchanged,
													oldRate: divideDecimal(2, 9000),
													newRate: divideDecimal(4, 9000),
												});

												assert.bnClose(rebateAmount, expected.rebateAmount, bnCloseVariance);
												assert.bnEqual(reclaimAmount, expected.reclaimAmount);
											});
											describe('when settlement is invoked', () => {
												it('then it reverts as the waiting period has not ended', async () => {
													await assert.revert(
														dpassive.settle(dBTC, { from: account1 }),
														'Cannot settle during waiting period'
													);
												});
											});
											describe('when the price gains for dBTC more than the loss of the dEUR change', () => {
												beforeEach(async () => {
													await fastForward(5);
													timestamp = await currentTime();
													await exchangeRates.updateRates(
														[dBTC],
														['20000'].map(toUnit),
														timestamp,
														{
															from: oracle,
														}
													);
												});
												it('then the reclaimAmount is whats left when subtracting the rebate', async () => {
													const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
														account1,
														dBTC
													);

													const expected = calculateExpectedSettlementAmount({
														amount: amountOfSrcExchanged,
														oldRate: divideDecimal(2, 9000),
														newRate: divideDecimal(4, 20000),
													});

													assert.bnEqual(rebateAmount, expected.rebateAmount);
													assert.bnClose(reclaimAmount, expected.reclaimAmount, bnCloseVariance);
												});
												describe('when the same user exchanges some dUSD into dBTC - the same destination', () => {
													let amountOfSrcExchangedSecondary;
													beforeEach(async () => {
														amountOfSrcExchangedSecondary = toUnit('10');
														await dpassive.exchange(dUSD, amountOfSrcExchangedSecondary, dBTC, {
															from: account1,
														});
													});
													it('then the reclaimAmount is unchanged', async () => {
														const {
															reclaimAmount,
															rebateAmount,
															numEntries,
														} = await exchanger.settlementOwing(account1, dBTC);

														const expected = calculateExpectedSettlementAmount({
															amount: amountOfSrcExchanged,
															oldRate: divideDecimal(2, 9000),
															newRate: divideDecimal(4, 20000),
														});

														assert.bnEqual(rebateAmount, expected.rebateAmount);
														assert.bnClose(reclaimAmount, expected.reclaimAmount, bnCloseVariance);
														assert.equal(
															numEntries,
															'2',
															'Must be two entries in the settlement queue'
														);
													});
													describe('when the price of dBTC lowers, turning the profit to a loss', () => {
														let expectedFromFirst;
														let expectedFromSecond;
														beforeEach(async () => {
															await fastForward(5);
															timestamp = await currentTime();

															await exchangeRates.updateRates(
																[dBTC],
																['10000'].map(toUnit),
																timestamp,
																{
																	from: oracle,
																}
															);

															expectedFromFirst = calculateExpectedSettlementAmount({
																amount: amountOfSrcExchanged,
																oldRate: divideDecimal(2, 9000),
																newRate: divideDecimal(4, 10000),
															});
															expectedFromSecond = calculateExpectedSettlementAmount({
																amount: amountOfSrcExchangedSecondary,
																oldRate: divideDecimal(1, 20000),
																newRate: divideDecimal(1, 10000),
															});
														});
														it('then the rebateAmount calculation of settlementOwing on dBTC includes both exchanges', async () => {
															const {
																reclaimAmount,
																rebateAmount,
															} = await exchanger.settlementOwing(account1, dBTC);

															assert.equal(reclaimAmount, '0');

															assert.bnClose(
																rebateAmount,
																expectedFromFirst.rebateAmount.add(expectedFromSecond.rebateAmount),
																bnCloseVariance
															);
														});
														describe('when another minute passes', () => {
															beforeEach(async () => {
																await fastForward(60);
															});
															describe('when settle() is invoked for dBTC', () => {
																it('then it settles with a rebate @gasprofile', async () => {
																	const txn = await dpassive.settle(dBTC, {
																		from: account1,
																	});

																	await ensureTxnEmitsSettlementEvents({
																		hash: txn.tx,
																		synth: dBTCContract,
																		expected: {
																			reclaimAmount: new web3.utils.BN(0),
																			rebateAmount: expectedFromFirst.rebateAmount.add(
																				expectedFromSecond.rebateAmount
																			),
																		},
																	});
																});
															});
														});
														describe('when another minute passes and the exchange fee rate has increased', () => {
															beforeEach(async () => {
																await fastForward(60);
																systemSettings.setExchangeFeeRateForSynths(
																	[dBTC],
																	[toUnit('0.1')],
																	{
																		from: owner,
																	}
																);
															});
															describe('when settle() is invoked for dBTC', () => {
																it('then it settles with a rebate using the exchange fee rate at time of trade', async () => {
																	const { tx: hash } = await dpassive.settle(dBTC, {
																		from: account1,
																	});

																	await ensureTxnEmitsSettlementEvents({
																		hash,
																		synth: dBTCContract,
																		expected: {
																			reclaimAmount: new web3.utils.BN(0),
																			rebateAmount: expectedFromFirst.rebateAmount.add(
																				expectedFromSecond.rebateAmount
																			),
																		},
																	});
																});
															});
														});
													});
												});
											});
										});
									});

									describe('and the max number of exchange entries is 5', () => {
										beforeEach(async () => {
											await exchangeState.setMaxEntriesInQueue('5', { from: owner });
										});
										describe('when a user tries to exchange 100 dEUR into dBTC 5 times', () => {
											beforeEach(async () => {
												const txns = [];
												for (let i = 0; i < 5; i++) {
													txns.push(
														await dpassive.exchange(dEUR, toUnit('100'), dBTC, { from: account1 })
													);
												}
											});
											it('then all succeed', () => {});
											it('when one more is tried, then if fails', async () => {
												await assert.revert(
													dpassive.exchange(dEUR, toUnit('100'), dBTC, { from: account1 }),
													'Max queue length reached'
												);
											});
											describe('when more than 60s elapses', () => {
												beforeEach(async () => {
													await fastForward(70);
												});
												describe('and the user invokes settle() on the dest synth', () => {
													beforeEach(async () => {
														await dpassive.settle(dBTC, { from: account1 });
													});
													it('then when the user performs 5 more exchanges into the same synth, it succeeds', async () => {
														for (let i = 0; i < 5; i++) {
															await dpassive.exchange(dEUR, toUnit('100'), dBTC, {
																from: account1,
															});
														}
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});
		});
	};

	const itCalculatesAmountAfterSettlement = () => {
		describe('calculateAmountAfterSettlement()', () => {
			describe('given a user has 1000 dEUR', () => {
				beforeEach(async () => {
					await dEURContract.issue(account1, toUnit('1000'));
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount < 1000 and no refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							dEUR,
							toUnit('500'),
							'0'
						);
					});
					it('then the response is the given amount of 500', () => {
						assert.bnEqual(response, toUnit('500'));
					});
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount < 1000 and a refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							dEUR,
							toUnit('500'),
							toUnit('25')
						);
					});
					it('then the response is the given amount of 500 plus the refund', () => {
						assert.bnEqual(response, toUnit('525'));
					});
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount > 1000 and no refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							dEUR,
							toUnit('1200'),
							'0'
						);
					});
					it('then the response is the balance of 1000', () => {
						assert.bnEqual(response, toUnit('1000'));
					});
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount > 1000 and a refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							dEUR,
							toUnit('1200'),
							toUnit('50')
						);
					});
					it('then the response is the given amount of 1000 plus the refund', () => {
						assert.bnEqual(response, toUnit('1050'));
					});
				});
			});
		});
	};

	const itExchanges = () => {
		describe('exchange()', () => {
			it('exchange() cannot be invoked directly by any account', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: exchanger.exchange,
					accounts,
					args: [account1, dUSD, toUnit('100'), dAUD, account1],
					reason: 'Only dpassive or a synth contract can perform this action',
				});
			});

			describe('suspension conditions on DPassive.exchange()', () => {
				const synth = dETH;
				['System', 'Exchange', 'SynthExchange', 'Synth'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true, synth });
						});
						it('then calling exchange() reverts', async () => {
							await assert.revert(
								dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 }),
								'Operation prohibited'
							);
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false, synth });
							});
							it('then calling exchange() succeeds', async () => {
								await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
							});
						});
					});
				});
				describe('when Synth(dBTC) is suspended', () => {
					beforeEach(async () => {
						// issue dAUD to test non-dUSD exchanges
						await dAUDContract.issue(account2, toUnit('100'));

						await setStatus({ owner, systemStatus, section: 'Synth', suspend: true, synth: dBTC });
					});
					it('then exchanging other synths still works', async () => {
						await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
						await dpassive.exchange(dAUD, toUnit('1'), dETH, { from: account2 });
					});
				});
			});

			it('exchangeWithTracking() cannot be invoked directly by any account via Exchanger', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: exchanger.exchangeWithTracking,
					accounts,
					args: [account1, dUSD, toUnit('100'), dAUD, account2, account3, trackingCode],
					reason: 'Only dpassive or a synth contract can perform this action',
				});
			});

			describe('various exchange scenarios', () => {
				describe('when a user has 1000 dUSD', () => {
					// already issued in the top-level beforeEach

					it('should allow a user to exchange the synths they hold in one flavour for another', async () => {
						// Exchange dUSD to dAUD
						await dpassive.exchange(dUSD, amountIssued, dAUD, { from: account1 });

						// Get the exchange amounts
						const {
							amountReceived,
							fee,
							exchangeFeeRate: feeRate,
						} = await exchanger.getAmountsForExchange(amountIssued, dUSD, dAUD);

						// Assert we have the correct AUD value - exchange fee
						const dAUDBalance = await dAUDContract.balanceOf(account1);
						assert.bnEqual(amountReceived, dAUDBalance);

						// Assert we have the exchange fee to distribute
						const feePeriodZero = await feePool.recentFeePeriods(0);
						const usdFeeAmount = await exchangeRates.effectiveValue(dAUD, fee, dUSD);
						assert.bnEqual(usdFeeAmount, feePeriodZero.feesToDistribute);

						assert.bnEqual(feeRate, exchangeFeeRate);
					});

					it('should emit a SynthExchange event @gasprofile', async () => {
						// Exchange dUSD to dAUD
						const txn = await dpassive.exchange(dUSD, amountIssued, dAUD, {
							from: account1,
						});

						const dAUDBalance = await dAUDContract.balanceOf(account1);

						const synthExchangeEvent = txn.logs.find(log => log.event === 'SynthExchange');
						assert.eventEqual(synthExchangeEvent, 'SynthExchange', {
							account: account1,
							fromCurrencyKey: toBytes32('dUSD'),
							fromAmount: amountIssued,
							toCurrencyKey: toBytes32('dAUD'),
							toAmount: dAUDBalance,
							toAddress: account1,
						});
					});

					it('should emit an ExchangeTracking event @gasprofile', async () => {
						// Exchange dUSD to dAUD
						const txn = await dpassive.exchangeWithTracking(
							dUSD,
							amountIssued,
							dAUD,
							account1,
							trackingCode,
							{
								from: account1,
							}
						);

						const { fee } = await exchanger.getAmountsForExchange(amountIssued, dUSD, dAUD);
						const usdFeeAmount = await exchangeRates.effectiveValue(dAUD, fee, dUSD);

						const dAUDBalance = await dAUDContract.balanceOf(account1);

						const synthExchangeEvent = txn.logs.find(log => log.event === 'SynthExchange');
						assert.eventEqual(synthExchangeEvent, 'SynthExchange', {
							account: account1,
							fromCurrencyKey: toBytes32('dUSD'),
							fromAmount: amountIssued,
							toCurrencyKey: toBytes32('dAUD'),
							toAmount: dAUDBalance,
							toAddress: account1,
						});

						const trackingEvent = txn.logs.find(log => log.event === 'ExchangeTracking');
						assert.eventEqual(trackingEvent, 'ExchangeTracking', {
							trackingCode,
							toCurrencyKey: toBytes32('dAUD'),
							toAmount: dAUDBalance,
							fee: usdFeeAmount,
						});
					});

					it('when a user tries to exchange more than they have, then it fails', async () => {
						await assert.revert(
							dpassive.exchange(dAUD, toUnit('1'), dUSD, {
								from: account1,
							}),
							'SafeMath: subtraction overflow'
						);
					});

					it('when a user tries to exchange more than they have, then it fails', async () => {
						await assert.revert(
							dpassive.exchange(dUSD, toUnit('1001'), dAUD, {
								from: account1,
							}),
							'SafeMath: subtraction overflow'
						);
					});

					[
						'exchange',
						'exchangeOnBehalf',
						'exchangeWithTracking',
						'exchangeOnBehalfWithTracking',
					].forEach(type => {
						describe(`rate stale scenarios for ${type}`, () => {
							const exchange = ({ from, to, amount }) => {
								if (type === 'exchange')
									return dpassive.exchange(from, amount, to, { from: account1 });
								else if (type === 'exchangeOnBehalf')
									return dpassive.exchangeOnBehalf(account1, from, amount, to, { from: account2 });
								if (type === 'exchangeWithTracking')
									return dpassive.exchangeWithTracking(from, amount, to, account1, trackingCode, {
										from: account1,
									});
								else if (type === 'exchangeOnBehalfWithTracking')
									return dpassive.exchangeOnBehalfWithTracking(
										account1,
										from,
										amount,
										to,
										account2,
										trackingCode,
										{ from: account2 }
									);
							};

							beforeEach(async () => {
								await delegateApprovals.approveExchangeOnBehalf(account2, { from: account1 });
							});
							describe('when rates have gone stale for all synths', () => {
								beforeEach(async () => {
									await fastForward(
										(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
									);
								});
								it(`attempting to ${type} from dUSD into dAUD reverts with dest stale`, async () => {
									await assert.revert(
										exchange({ from: dUSD, amount: amountIssued, to: dAUD }),
										'Src/dest rate invalid or not found'
									);
								});
								it('settling still works ', async () => {
									await dpassive.settle(dAUD, { from: account1 });
								});
								describe('when that synth has a fresh rate', () => {
									beforeEach(async () => {
										const timestamp = await currentTime();

										await exchangeRates.updateRates([dAUD], ['0.75'].map(toUnit), timestamp, {
											from: oracle,
										});
									});
									describe(`when the user ${type} into that synth`, () => {
										beforeEach(async () => {
											await exchange({ from: dUSD, amount: amountIssued, to: dAUD });
										});
										describe('after the waiting period expires and the synth has gone stale', () => {
											beforeEach(async () => {
												await fastForward(
													(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
												);
											});
											it(`${type} back to dUSD fails as the source has no rate`, async () => {
												await assert.revert(
													exchange({ from: dAUD, amount: amountIssued, to: dUSD }),
													'Src/dest rate invalid or not found'
												);
											});
										});
									});
								});
							});
						});
					});

					describe('exchanging on behalf', async () => {
						const authoriser = account1;
						const delegate = account2;

						it('exchangeOnBehalf() cannot be invoked directly by any account via Exchanger', async () => {
							await onlyGivenAddressCanInvoke({
								fnc: exchanger.exchangeOnBehalf,
								accounts,
								args: [authoriser, delegate, dUSD, toUnit('100'), dAUD],
								reason: 'Only dpassive or a synth contract can perform this action',
							});
						});

						describe('when not approved it should revert on', async () => {
							it('exchangeOnBehalf', async () => {
								await assert.revert(
									dpassive.exchangeOnBehalf(authoriser, dAUD, toUnit('1'), dUSD, {
										from: delegate,
									}),
									'Not approved to act on behalf'
								);
							});
						});
						describe('when delegate address approved to exchangeOnBehalf', async () => {
							// (dUSD amount issued earlier in top-level beforeEach)
							beforeEach(async () => {
								await delegateApprovals.approveExchangeOnBehalf(delegate, { from: authoriser });
							});
							describe('suspension conditions on DPassive.exchangeOnBehalf()', () => {
								const synth = dAUD;
								['System', 'Exchange', 'SynthExchange', 'Synth'].forEach(section => {
									describe(`when ${section} is suspended`, () => {
										beforeEach(async () => {
											await setStatus({ owner, systemStatus, section, suspend: true, synth });
										});
										it('then calling exchange() reverts', async () => {
											await assert.revert(
												dpassive.exchangeOnBehalf(authoriser, dUSD, amountIssued, dAUD, {
													from: delegate,
												}),
												'Operation prohibited'
											);
										});
										describe(`when ${section} is resumed`, () => {
											beforeEach(async () => {
												await setStatus({ owner, systemStatus, section, suspend: false, synth });
											});
											it('then calling exchange() succeeds', async () => {
												await dpassive.exchangeOnBehalf(authoriser, dUSD, amountIssued, dAUD, {
													from: delegate,
												});
											});
										});
									});
								});
								describe('when Synth(dBTC) is suspended', () => {
									beforeEach(async () => {
										await setStatus({
											owner,
											systemStatus,
											section: 'Synth',
											suspend: true,
											synth: dBTC,
										});
									});
									it('then exchanging other synths on behalf still works', async () => {
										await dpassive.exchangeOnBehalf(authoriser, dUSD, amountIssued, dAUD, {
											from: delegate,
										});
									});
								});
							});

							it('should revert if non-delegate invokes exchangeOnBehalf', async () => {
								await onlyGivenAddressCanInvoke({
									fnc: dpassive.exchangeOnBehalf,
									args: [authoriser, dUSD, amountIssued, dAUD],
									accounts,
									address: delegate,
									reason: 'Not approved to act on behalf',
								});
							});
							it('should exchangeOnBehalf and authoriser recieves the destSynth', async () => {
								// Exchange dUSD to dAUD
								await dpassive.exchangeOnBehalf(authoriser, dUSD, amountIssued, dAUD, {
									from: delegate,
								});

								const { amountReceived, fee } = await exchanger.getAmountsForExchange(
									amountIssued,
									dUSD,
									dAUD
								);

								// Assert we have the correct AUD value - exchange fee
								const dAUDBalance = await dAUDContract.balanceOf(authoriser);
								assert.bnEqual(amountReceived, dAUDBalance);

								// Assert we have the exchange fee to distribute
								const feePeriodZero = await feePool.recentFeePeriods(0);
								const usdFeeAmount = await exchangeRates.effectiveValue(dAUD, fee, dUSD);
								assert.bnEqual(usdFeeAmount, feePeriodZero.feesToDistribute);
							});
						});
					});

					describe('exchanging on behalf with tracking', async () => {
						const authoriser = account1;
						const delegate = account2;

						it('exchangeOnBehalfWithTracking() cannot be invoked directly by any account via Exchanger', async () => {
							await onlyGivenAddressCanInvoke({
								fnc: exchanger.exchangeOnBehalfWithTracking,
								accounts,
								args: [authoriser, delegate, dUSD, toUnit('100'), dAUD, authoriser, trackingCode],
								reason: 'Only dpassive or a synth contract can perform this action',
							});
						});

						describe('when not approved it should revert on', async () => {
							it('exchangeOnBehalfWithTracking', async () => {
								await assert.revert(
									dpassive.exchangeOnBehalfWithTracking(
										authoriser,
										dAUD,
										toUnit('1'),
										dUSD,
										authoriser,
										trackingCode,
										{ from: delegate }
									),
									'Not approved to act on behalf'
								);
							});
						});
						describe('when delegate address approved to exchangeOnBehalf', async () => {
							// (dUSD amount issued earlier in top-level beforeEach)
							beforeEach(async () => {
								await delegateApprovals.approveExchangeOnBehalf(delegate, { from: authoriser });
							});
							describe('suspension conditions on DPassive.exchangeOnBehalfWithTracking()', () => {
								const synth = dAUD;
								['System', 'Exchange', 'SynthExchange', 'Synth'].forEach(section => {
									describe(`when ${section} is suspended`, () => {
										beforeEach(async () => {
											await setStatus({ owner, systemStatus, section, suspend: true, synth });
										});
										it('then calling exchange() reverts', async () => {
											await assert.revert(
												dpassive.exchangeOnBehalfWithTracking(
													authoriser,
													dUSD,
													amountIssued,
													dAUD,
													authoriser,
													trackingCode,
													{
														from: delegate,
													}
												),
												'Operation prohibited'
											);
										});
										describe(`when ${section} is resumed`, () => {
											beforeEach(async () => {
												await setStatus({ owner, systemStatus, section, suspend: false, synth });
											});
											it('then calling exchange() succeeds', async () => {
												await dpassive.exchangeOnBehalfWithTracking(
													authoriser,
													dUSD,
													amountIssued,
													dAUD,
													authoriser,
													trackingCode,
													{
														from: delegate,
													}
												);
											});
										});
									});
								});
								describe('when Synth(dBTC) is suspended', () => {
									beforeEach(async () => {
										await setStatus({
											owner,
											systemStatus,
											section: 'Synth',
											suspend: true,
											synth: dBTC,
										});
									});
									it('then exchanging other synths on behalf still works', async () => {
										await dpassive.exchangeOnBehalfWithTracking(
											authoriser,
											dUSD,
											amountIssued,
											dAUD,
											authoriser,
											trackingCode,
											{
												from: delegate,
											}
										);
									});
								});
							});

							it('should revert if non-delegate invokes exchangeOnBehalf', async () => {
								await onlyGivenAddressCanInvoke({
									fnc: dpassive.exchangeOnBehalfWithTracking,
									args: [authoriser, dUSD, amountIssued, dAUD, authoriser, trackingCode],
									accounts,
									address: delegate,
									reason: 'Not approved to act on behalf',
								});
							});
							it('should exchangeOnBehalf and authoriser recieves the destSynth', async () => {
								// Exchange dUSD to dAUD
								const txn = await dpassive.exchangeOnBehalfWithTracking(
									authoriser,
									dUSD,
									amountIssued,
									dAUD,
									authoriser,
									trackingCode,
									{
										from: delegate,
									}
								);

								const { amountReceived, fee } = await exchanger.getAmountsForExchange(
									amountIssued,
									dUSD,
									dAUD
								);

								// Assert we have the correct AUD value - exchange fee
								const dAUDBalance = await dAUDContract.balanceOf(authoriser);
								assert.bnEqual(amountReceived, dAUDBalance);

								// Assert we have the exchange fee to distribute
								const feePeriodZero = await feePool.recentFeePeriods(0);
								const usdFeeAmount = await exchangeRates.effectiveValue(dAUD, fee, dUSD);
								assert.bnEqual(usdFeeAmount, feePeriodZero.feesToDistribute);

								// Assert the tracking event is fired.
								const trackingEvent = txn.logs.find(log => log.event === 'ExchangeTracking');
								assert.eventEqual(trackingEvent, 'ExchangeTracking', {
									trackingCode,
									toCurrencyKey: toBytes32('dAUD'),
									toAmount: dAUDBalance,
									fee: usdFeeAmount,
								});
							});
						});
					});
				});
			});

			describe('when dealing with inverted synths', () => {
				describe('when price spike deviation is set to a factor of 2.5', () => {
					beforeEach(async () => {
						await systemSettings.setPriceDeviationThresholdFactor(toUnit('2.5'), { from: owner });
					});
					describe('when the iBTC synth is set with inverse pricing', () => {
						const iBTCEntryPoint = toUnit(4000);
						beforeEach(async () => {
							await exchangeRates.setInversePricing(
								iBTC,
								iBTCEntryPoint,
								toUnit(6500),
								toUnit(1000),
								false,
								false,
								{
									from: owner,
								}
							);
						});
						describe('when a user holds holds 100,000 DPS', () => {
							beforeEach(async () => {
								await dpassive.transfer(account1, toUnit(1e5), {
									from: owner,
								});
							});

							describe('when a price within bounds for iBTC is received', () => {
								const iBTCPrice = toUnit(6000);
								beforeEach(async () => {
									await exchangeRates.updateRates([iBTC], [iBTCPrice], timestamp, {
										from: oracle,
									});
								});
								describe('when the user tries to mint 1% of their DPS value', () => {
									const amountIssued = toUnit(1e3);
									beforeEach(async () => {
										// Issue
										await dUSDContract.issue(account1, amountIssued);
									});
									describe('when the user tries to exchange some dUSD into iBTC', () => {
										const assertExchangeSucceeded = async ({
											amountExchanged,
											txn,
											from = dUSD,
											to = iBTC,
											toContract = iBTCContract,
											prevBalance,
										}) => {
											// Note: this presumes balance was empty before the exchange - won't work when
											// exchanging into dUSD as there is an existing dUSD balance from minting
											const actualExchangeFee = await exchanger.feeRateForExchange(from, to);
											const balance = await toContract.balanceOf(account1);
											const effectiveValue = await exchangeRates.effectiveValue(
												from,
												amountExchanged,
												to
											);
											const effectiveValueMinusFees = effectiveValue.sub(
												multiplyDecimal(effectiveValue, actualExchangeFee)
											);

											const balanceFromExchange = prevBalance ? balance.sub(prevBalance) : balance;

											assert.bnEqual(balanceFromExchange, effectiveValueMinusFees);

											// check logs
											const synthExchangeEvent = txn.logs.find(
												log => log.event === 'SynthExchange'
											);

											assert.eventEqual(synthExchangeEvent, 'SynthExchange', {
												fromCurrencyKey: from,
												fromAmount: amountExchanged,
												toCurrencyKey: to,
												toAmount: effectiveValueMinusFees,
												toAddress: account1,
											});
										};
										let exchangeTxns;
										const amountExchanged = toUnit(1e2);
										beforeEach(async () => {
											exchangeTxns = [];
											exchangeTxns.push(
												await dpassive.exchange(dUSD, amountExchanged, iBTC, {
													from: account1,
												})
											);
										});
										it('then it exchanges correctly into iBTC', async () => {
											await assertExchangeSucceeded({
												amountExchanged,
												txn: exchangeTxns[0],
												from: dUSD,
												to: iBTC,
												toContract: iBTCContract,
											});
										});
										describe('when the user tries to exchange some iBTC into another synth', () => {
											const newAmountExchanged = toUnit(0.003); // current iBTC balance is a bit under 0.05

											beforeEach(async () => {
												await fastForward(500); // fast forward through waiting period
												exchangeTxns.push(
													await dpassive.exchange(iBTC, newAmountExchanged, dAUD, {
														from: account1,
													})
												);
											});
											it('then it exchanges correctly out of iBTC', async () => {
												await assertExchangeSucceeded({
													amountExchanged: newAmountExchanged,
													txn: exchangeTxns[1],
													from: iBTC,
													to: dAUD,
													toContract: dAUDContract,
													exchangeFeeRateMultiplier: 1,
												});
											});

											describe('when a price outside of bounds for iBTC is received', () => {
												const newiBTCPrice = toUnit(7500);
												beforeEach(async () => {
													// prevent price spike from being hit
													const newTimestamp = await currentTime();
													await exchangeRates.updateRates([iBTC], [newiBTCPrice], newTimestamp, {
														from: oracle,
													});
												});
												describe('when the user tries to exchange some iBTC again', () => {
													beforeEach(async () => {
														await fastForward(500); // fast forward through waiting period

														exchangeTxns.push(
															await dpassive.exchange(iBTC, toUnit(0.001), dEUR, {
																from: account1,
															})
														);
													});
													it('then it still exchanges correctly into iBTC even when frozen', async () => {
														await assertExchangeSucceeded({
															amountExchanged: toUnit(0.001),
															txn: exchangeTxns[2],
															from: iBTC,
															to: dEUR,
															toContract: dEURContract,
															exchangeFeeRateMultiplier: 1,
														});
													});
												});
												describe('when the user tries to exchange iBTC into another synth', () => {
													beforeEach(async () => {
														await fastForward(500); // fast forward through waiting period

														exchangeTxns.push(
															await dpassive.exchange(iBTC, newAmountExchanged, dEUR, {
																from: account1,
															})
														);
													});
													it('then it exchanges correctly out of iBTC, even while frozen', async () => {
														await assertExchangeSucceeded({
															amountExchanged: newAmountExchanged,
															txn: exchangeTxns[2],
															from: iBTC,
															to: dEUR,
															toContract: dEURContract,
															exchangeFeeRateMultiplier: 1,
														});
													});
												});
											});
										});
										describe('doubling of fees for swing trades', () => {
											const iBTCexchangeAmount = toUnit(0.002); // current iBTC balance is a bit under 0.05
											let txn;
											describe('when the user tries to exchange some short iBTC into long dBTC', () => {
												beforeEach(async () => {
													await fastForward(500); // fast forward through waiting period

													txn = await dpassive.exchange(iBTC, iBTCexchangeAmount, dBTC, {
														from: account1,
													});
												});
												it('then it exchanges correctly from iBTC to dBTC, doubling the fee based on the destination Synth', async () => {
													// get exchange fee for dUSD to dBTC (Base rate for destination synth)
													const baseExchangeRate = await exchanger.feeRateForExchange(dUSD, dBTC);
													const expectedExchangeRate = await exchanger.feeRateForExchange(
														iBTC,
														dBTC
													);

													// swing trade should be double the base exchange fee
													assert.bnEqual(expectedExchangeRate, baseExchangeRate.mul(new BN(2)));

													await assertExchangeSucceeded({
														amountExchanged: iBTCexchangeAmount,
														txn,
														from: iBTC,
														to: dBTC,
														toContract: dBTCContract,
													});
												});
												describe('when the user tries to exchange some short iBTC into dEUR', () => {
													beforeEach(async () => {
														await fastForward(500); // fast forward through waiting period

														txn = await dpassive.exchange(iBTC, iBTCexchangeAmount, dEUR, {
															from: account1,
														});
													});
													it('then it exchanges correctly from iBTC to dEUR, doubling the fee', async () => {
														// get exchange fee for dUSD to dEUR (Base rate for destination synth)
														const baseExchangeRate = await exchanger.feeRateForExchange(dUSD, dEUR);
														const expectedExchangeRate = await exchanger.feeRateForExchange(
															iBTC,
															dEUR
														);

														// swing trade should be double the base exchange fee
														assert.bnEqual(expectedExchangeRate, baseExchangeRate.mul(new BN(2)));

														await assertExchangeSucceeded({
															amountExchanged: iBTCexchangeAmount,
															txn,
															from: iBTC,
															to: dEUR,
															toContract: dEURContract,
														});
													});
													describe('when the user tries to exchange some dEUR for iBTC', () => {
														const dEURExchangeAmount = toUnit(0.001);
														let prevBalance;
														beforeEach(async () => {
															await fastForward(500); // fast forward through waiting period

															prevBalance = await iBTCContract.balanceOf(account1);
															txn = await dpassive.exchange(dEUR, dEURExchangeAmount, iBTC, {
																from: account1,
															});
														});
														it('then it exchanges correctly from dEUR to iBTC, doubling the fee', async () => {
															// get exchange fee for dUSD to iBTC (Base rate for destination synth)
															const baseExchangeRate = await exchanger.feeRateForExchange(
																dUSD,
																iBTC
															);
															const expectedExchangeRate = await exchanger.feeRateForExchange(
																dEUR,
																iBTC
															);

															// swing trade should be double the base exchange fee
															assert.bnEqual(expectedExchangeRate, baseExchangeRate.mul(new BN(2)));

															await assertExchangeSucceeded({
																amountExchanged: dEURExchangeAmount,
																txn,
																from: dEUR,
																to: iBTC,
																toContract: iBTCContract,
																prevBalance,
															});
														});
													});
												});
											});
											describe('when the user tries to exchange some short iBTC for dUSD', () => {
												let prevBalance;

												beforeEach(async () => {
													await fastForward(500); // fast forward through waiting period

													prevBalance = await dUSDContract.balanceOf(account1);
													txn = await dpassive.exchange(iBTC, iBTCexchangeAmount, dUSD, {
														from: account1,
													});
												});
												it('then it exchanges correctly out of iBTC, with the regular fee', async () => {
													// get exchange fee for dETH to dUSD (Base rate for destination synth into dUSD)
													const baseExchangeRate = await exchanger.feeRateForExchange(dETH, dUSD);
													const expectedExchangeRate = await exchanger.feeRateForExchange(
														iBTC,
														dUSD
													);

													// exchange fee should be the same base exchange fee
													assert.bnEqual(expectedExchangeRate, baseExchangeRate);

													await assertExchangeSucceeded({
														amountExchanged: iBTCexchangeAmount,
														txn,
														from: iBTC,
														to: dUSD,
														toContract: dUSDContract,
														prevBalance,
													});
												});
											});
										});
										describe('edge case: frozen rate does not apply to old settlement', () => {
											describe('when a price outside the bounds arrives for iBTC', () => {
												beforeEach(async () => {
													const newTimestamp = await currentTime();
													await exchangeRates.updateRates([iBTC], [toUnit('8000')], newTimestamp, {
														from: oracle,
													});
												});
												it('then settlement owing shows some rebate', async () => {
													const {
														reclaimAmount,
														rebateAmount,
														numEntries,
													} = await exchanger.settlementOwing(account1, iBTC);

													assert.equal(reclaimAmount, '0');
													assert.notEqual(rebateAmount, '0');
													assert.equal(numEntries, '1');
												});
												describe('when a user freezes iBTC', () => {
													beforeEach(async () => {
														await exchangeRates.freezeRate(iBTC, { from: account1 });
													});
													it('then settlement owing still shows some rebate', async () => {
														const {
															reclaimAmount,
															rebateAmount,
															numEntries,
														} = await exchanger.settlementOwing(account1, iBTC);

														assert.equal(reclaimAmount, '0');
														assert.notEqual(rebateAmount, '0');
														assert.equal(numEntries, '1');
													});
												});
											});
											describe('when the waiting period expires', () => {
												beforeEach(async () => {
													await fastForward(500); // fast forward through waiting period
												});
												it('then settlement owing shows 0', async () => {
													const {
														reclaimAmount,
														rebateAmount,
														numEntries,
													} = await exchanger.settlementOwing(account1, iBTC);

													assert.equal(reclaimAmount, '0');
													assert.equal(rebateAmount, '0');
													assert.equal(numEntries, '1');
												});
												describe('when a price outside the bounds arrives for iBTC', () => {
													beforeEach(async () => {
														const newTimestamp = await currentTime();
														await exchangeRates.updateRates(
															[iBTC],
															[toUnit('12000')],
															newTimestamp,
															{
																from: oracle,
															}
														);
													});
													describe('when a user freezes iBTC', () => {
														beforeEach(async () => {
															await exchangeRates.freezeRate(iBTC, { from: account1 });
														});
														it('then settlement owing still shows 0', async () => {
															const {
																reclaimAmount,
																rebateAmount,
																numEntries,
															} = await exchanger.settlementOwing(account1, iBTC);

															assert.equal(reclaimAmount, '0');
															assert.equal(rebateAmount, '0');
															assert.equal(numEntries, '1');
														});
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});

			describe('edge case: when an aggregator has a 0 rate', () => {
				describe('when an aggregator is added to the exchangeRates', () => {
					let aggregator;

					beforeEach(async () => {
						aggregator = await MockAggregator.new({ from: owner });
						await exchangeRates.addAggregator(dETH, aggregator.address, { from: owner });
						// set a 0 rate to prevent invalid rate from causing a revert on exchange
						await aggregator.setLatestAnswer('0', await currentTime());
					});

					describe('when exchanging into that synth', () => {
						it('then it causes a suspension from price deviation as the price is 9', async () => {
							const { tx: hash } = await dpassive.exchange(dUSD, toUnit('1'), dETH, {
								from: account1,
							});

							const logs = await getDecodedLogs({
								hash,
								contracts: [dpassive, exchanger, systemStatus],
							});

							// assert no exchange
							assert.ok(!logs.some(({ name } = {}) => name === 'SynthExchange'));

							// assert suspension
							const { suspended, reason } = await systemStatus.synthSuspension(dETH);
							assert.ok(suspended);
							assert.equal(reason, '65');
						});
					});
					describe('when exchanging out of that synth', () => {
						beforeEach(async () => {
							// give the user some dETH
							await dETHContract.issue(account1, toUnit('1'));
						});
						it('then it causes a suspension from price deviation', async () => {
							// await assert.revert(
							const { tx: hash } = await dpassive.exchange(dETH, toUnit('1'), dUSD, {
								from: account1,
							});

							const logs = await getDecodedLogs({
								hash,
								contracts: [dpassive, exchanger, systemStatus],
							});

							// assert no exchange
							assert.ok(!logs.some(({ name } = {}) => name === 'SynthExchange'));

							// assert suspension
							const { suspended, reason } = await systemStatus.synthSuspension(dETH);
							assert.ok(suspended);
							assert.equal(reason, '65');
						});
					});
				});
			});
		});
	};

	const itExchangesWithVirtual = () => {
		describe('exchangeWithVirtual()', () => {
			describe('when a user has 1000 dUSD', () => {
				describe('when the waiting period is set to 60s', () => {
					beforeEach(async () => {
						await systemSettings.setWaitingPeriodSecs('60', { from: owner });
					});
					describe('when a user exchanges into dAUD using virtual synths with a tracking code', () => {
						let logs;
						let amountReceived;
						let exchangeFeeRate;
						let findNamedEventValue;
						let vSynthAddress;

						beforeEach(async () => {
							const txn = await dpassive.exchangeWithVirtual(
								dUSD,
								amountIssued,
								dAUD,
								toBytes32('AGGREGATOR'),
								{
									from: account1,
								}
							);

							({ amountReceived, exchangeFeeRate } = await exchanger.getAmountsForExchange(
								amountIssued,
								dUSD,
								dAUD
							));

							logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [dpassive, exchanger, dUSDContract, issuer, flexibleStorage, debtCache],
							});
							const vSynthCreatedEvent = logs.find(({ name }) => name === 'VirtualSynthCreated');
							assert.ok(vSynthCreatedEvent, 'Found VirtualSynthCreated event');
							findNamedEventValue = param =>
								vSynthCreatedEvent.events.find(({ name }) => name === param);
							vSynthAddress = findNamedEventValue('vSynth').value;
						});

						it('then it emits an ExchangeEntryAppended for the new Virtual Synth', async () => {
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'ExchangeEntryAppended'),
								event: 'ExchangeEntryAppended',
								emittedFrom: exchanger.address,
								args: [
									vSynthAddress,
									dUSD,
									amountIssued,
									dAUD,
									amountReceived,
									exchangeFeeRate,
									new web3.utils.BN(1),
									new web3.utils.BN(2),
								],
								bnCloseVariance,
							});
						});

						it('then it emits an SynthExchange into the new Virtual Synth', async () => {
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'SynthExchange'),
								event: 'SynthExchange',
								emittedFrom: await dpassive.proxy(),
								args: [account1, dUSD, amountIssued, dAUD, amountReceived, vSynthAddress],
								bnCloseVariance: '0',
							});
						});

						it('then an ExchangeTracking is emitted with the correct code', async () => {
							const evt = logs.find(({ name }) => name === 'ExchangeTracking');
							assert.equal(
								evt.events.find(({ name }) => name === 'trackingCode').value,
								toBytes32('AGGREGATOR')
							);
						});

						it('and it emits the VirtualSynthCreated event', async () => {
							assert.equal(
								findNamedEventValue('synth').value,
								(await dAUDContract.proxy()).toLowerCase()
							);
							assert.equal(findNamedEventValue('currencyKey').value, dAUD);
							assert.equal(findNamedEventValue('amount').value, amountReceived);
							assert.equal(findNamedEventValue('recipient').value, account1.toLowerCase());
						});
						it('and the balance of the user is nothing', async () => {
							assert.bnEqual(await dAUDContract.balanceOf(account1), '0');
						});
						it('and the user has no fee reclamation entries', async () => {
							const { reclaimAmount, rebateAmount, numEntries } = await exchanger.settlementOwing(
								account1,
								dAUD
							);
							assert.equal(reclaimAmount, '0');
							assert.equal(rebateAmount, '0');
							assert.equal(numEntries, '0');
						});

						describe('with the new virtual synth', () => {
							let vSynth;
							beforeEach(async () => {
								vSynth = await artifacts.require('VirtualSynth').at(vSynthAddress);
							});
							it('and the balance of the vSynth is the whole amount', async () => {
								assert.bnEqual(await dAUDContract.balanceOf(vSynth.address), amountReceived);
							});
							it('then it is created with the correct parameters', async () => {
								assert.equal(await vSynth.resolver(), resolver.address);
								assert.equal(await vSynth.synth(), await dAUDContract.proxy());
								assert.equal(await vSynth.currencyKey(), dAUD);
								assert.bnEqual(await vSynth.totalSupply(), amountReceived);
								assert.bnEqual(await vSynth.balanceOf(account1), amountReceived);
								assert.notOk(await vSynth.settled());
							});
							it('and the vSynth has 1 fee reclamation entries', async () => {
								const { reclaimAmount, rebateAmount, numEntries } = await exchanger.settlementOwing(
									vSynth.address,
									dAUD
								);
								assert.equal(reclaimAmount, '0');
								assert.equal(rebateAmount, '0');
								assert.equal(numEntries, '1');
							});
							it('and the secsLeftInWaitingPeriod() returns the waitingPeriodSecs', async () => {
								const maxSecs = await vSynth.secsLeftInWaitingPeriod();
								timeIsClose({ actual: maxSecs, expected: 60, variance: 2 });
							});

							describe('when the waiting period expires', () => {
								beforeEach(async () => {
									// end waiting period
									await fastForward(await systemSettings.waitingPeriodSecs());
								});

								it('and the secsLeftInWaitingPeriod() returns 0', async () => {
									assert.equal(await vSynth.secsLeftInWaitingPeriod(), '0');
								});

								it('and readyToSettle() is true', async () => {
									assert.equal(await vSynth.readyToSettle(), true);
								});

								describe('when the vSynth is settled for the holder', () => {
									let txn;
									let logs;
									beforeEach(async () => {
										txn = await vSynth.settle(account1);

										logs = await getDecodedLogs({
											hash: txn.tx,
											contracts: [
												dpassive,
												exchanger,
												dUSDContract,
												issuer,
												flexibleStorage,
												debtCache,
											],
										});
									});

									it('then the user has all the synths', async () => {
										assert.bnEqual(await dAUDContract.balanceOf(account1), amountReceived);
									});

									it('and the vSynth is settled', async () => {
										assert.equal(await vSynth.settled(), true);
									});

									it('and ExchangeEntrySettled is emitted', async () => {
										const evt = logs.find(({ name }) => name === 'ExchangeEntrySettled');

										const findEvt = param => evt.events.find(({ name }) => name === param);

										assert.equal(findEvt('from').value, vSynth.address.toLowerCase());
									});

									it('and the entry is settled for the vSynth', async () => {
										const {
											reclaimAmount,
											rebateAmount,
											numEntries,
										} = await exchanger.settlementOwing(vSynth.address, dAUD);
										assert.equal(reclaimAmount, '0');
										assert.equal(rebateAmount, '0');
										assert.equal(numEntries, '0');
									});

									it('and the user still has no fee reclamation entries', async () => {
										const {
											reclaimAmount,
											rebateAmount,
											numEntries,
										} = await exchanger.settlementOwing(account1, dAUD);
										assert.equal(reclaimAmount, '0');
										assert.equal(rebateAmount, '0');
										assert.equal(numEntries, '0');
									});

									it('and no more supply exists in the vSynth', async () => {
										assert.equal(await vSynth.totalSupply(), '0');
									});
								});
							});
						});
					});

					describe('when a user exchanges without a tracking code', () => {
						let logs;
						beforeEach(async () => {
							const txn = await dpassive.exchangeWithVirtual(
								dUSD,
								amountIssued,
								dAUD,
								toBytes32(),
								{
									from: account1,
								}
							);

							logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [dpassive, exchanger, dUSDContract, issuer, flexibleStorage, debtCache],
							});
						});
						it('then no ExchangeTracking is emitted (as no tracking code supplied)', async () => {
							assert.notOk(logs.find(({ name }) => name === 'ExchangeTracking'));
						});
					});
				});
			});
		});
	};

	const itSetsLastExchangeRateForSynth = () => {
		describe('setLastExchangeRateForSynth() SIP-78', () => {
			it('cannot be invoked by any user', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: exchanger.setLastExchangeRateForSynth,
					args: [dEUR, toUnit('100')],
					accounts,
					reason: 'Restricted to ExchangeRates',
				});
			});

			describe('when ExchangeRates is spoofed using an account', () => {
				beforeEach(async () => {
					await resolver.importAddresses([toBytes32('ExchangeRates')], [account1], {
						from: owner,
					});
					await exchanger.rebuildCache();
				});
				it('reverts when invoked by ExchangeRates with a 0 rate', async () => {
					await assert.revert(
						exchanger.setLastExchangeRateForSynth(dEUR, '0', { from: account1 }),
						'Rate must be above 0'
					);
				});
				describe('when invoked with a real rate by ExchangeRates', () => {
					beforeEach(async () => {
						await exchanger.setLastExchangeRateForSynth(dEUR, toUnit('1.9'), { from: account1 });
					});
					it('then lastExchangeRate is set for the synth', async () => {
						assert.bnEqual(await exchanger.lastExchangeRate(dEUR), toUnit('1.9'));
					});
				});
			});
		});
	};

	const itPricesSpikeDeviation = () => {
		describe('priceSpikeDeviation', () => {
			const baseRate = 100;

			const updateRate = ({ target, rate }) => {
				beforeEach(async () => {
					await fastForward(10);
					await exchangeRates.updateRates(
						[target],
						[toUnit(rate.toString())],
						await currentTime(),
						{
							from: oracle,
						}
					);
				});
			};

			describe('resetLastExchangeRate() SIP-139', () => {
				it('cannot be invoked by any user', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: exchanger.resetLastExchangeRate,
						args: [[dEUR, dAUD]],
						accounts,
						address: owner,
						reason: 'Only the contract owner may perform this action',
					});
				});
				it('when invoked without valid exchange rates, it reverts', async () => {
					await assert.revert(
						exchanger.resetLastExchangeRate([dEUR, dAUD, toBytes32('dUNKNOWN')], { from: owner }),
						'Rates for given synths not valid'
					);
				});
			});

			describe(`when the price of dETH is ${baseRate}`, () => {
				updateRate({ target: dETH, rate: baseRate });

				describe('when price spike deviation is set to a factor of 2', () => {
					const baseFactor = 2;
					beforeEach(async () => {
						await systemSettings.setPriceDeviationThresholdFactor(toUnit(baseFactor.toString()), {
							from: owner,
						});
					});

					// lastExchangeRate, used for price deviations (SIP-65)
					describe('lastExchangeRate is persisted during exchanges', () => {
						it('initially has no entries', async () => {
							assert.equal(await exchanger.lastExchangeRate(dUSD), '0');
							assert.equal(await exchanger.lastExchangeRate(dETH), '0');
							assert.equal(await exchanger.lastExchangeRate(dEUR), '0');
						});
						describe('when a user exchanges into dETH from dUSD', () => {
							beforeEach(async () => {
								await dpassive.exchange(dUSD, toUnit('100'), dETH, { from: account1 });
							});
							it('then the source side has a rate persisted', async () => {
								assert.bnEqual(await exchanger.lastExchangeRate(dUSD), toUnit('1'));
							});
							it('and the dest side has a rate persisted', async () => {
								assert.bnEqual(await exchanger.lastExchangeRate(dETH), toUnit(baseRate.toString()));
							});
						});
						describe('when a user exchanges from dETH into another synth', () => {
							beforeEach(async () => {
								await dETHContract.issue(account1, toUnit('1'));
								await dpassive.exchange(dETH, toUnit('1'), dEUR, { from: account1 });
							});
							it('then the source side has a rate persisted', async () => {
								assert.bnEqual(await exchanger.lastExchangeRate(dETH), toUnit(baseRate.toString()));
							});
							it('and the dest side has a rate persisted', async () => {
								// Rate of 2 from shared setup code above
								assert.bnEqual(await exchanger.lastExchangeRate(dEUR), toUnit('2'));
							});
							describe('when the price of dETH changes slightly', () => {
								updateRate({ target: dETH, rate: baseRate * 1.1 });
								describe('and another user exchanges dETH to dUSD', () => {
									beforeEach(async () => {
										await dETHContract.issue(account2, toUnit('1'));
										await dpassive.exchange(dETH, toUnit('1'), dUSD, { from: account2 });
									});
									it('then the source side has a new rate persisted', async () => {
										assert.bnEqual(
											await exchanger.lastExchangeRate(dETH),
											toUnit((baseRate * 1.1).toString())
										);
									});
									it('and the dest side has a rate persisted', async () => {
										assert.bnEqual(await exchanger.lastExchangeRate(dUSD), toUnit('1'));
									});
								});
							});
							describe('when the price of dETH is over a deviation', () => {
								beforeEach(async () => {
									// dETH over deviation and dEUR slight change
									await fastForward(10);
									await exchangeRates.updateRates(
										[dETH, dEUR],
										[toUnit(baseRate * 3).toString(), toUnit('1.9')],
										await currentTime(),
										{
											from: oracle,
										}
									);
								});
								describe('and another user exchanges dETH to dEUR', () => {
									beforeEach(async () => {
										await dETHContract.issue(account2, toUnit('1'));
										await dpassive.exchange(dETH, toUnit('1'), dEUR, { from: account2 });
									});
									it('then the source side has not persisted the rate', async () => {
										assert.bnEqual(
											await exchanger.lastExchangeRate(dETH),
											toUnit(baseRate.toString())
										);
									});
									it('then the dest side has not persisted the rate', async () => {
										assert.bnEqual(await exchanger.lastExchangeRate(dEUR), toUnit('2'));
									});
								});
							});
							describe('when the price of dEUR is over a deviation', () => {
								beforeEach(async () => {
									// dEUR over deviation and dETH slight change
									await fastForward(10);
									await exchangeRates.updateRates(
										[dETH, dEUR],
										[toUnit(baseRate * 1.1).toString(), toUnit('10')],
										await currentTime(),
										{
											from: oracle,
										}
									);
								});
								describe('and another user exchanges dEUR to dETH', () => {
									beforeEach(async () => {
										await dETHContract.issue(account2, toUnit('1'));
										await dpassive.exchange(dETH, toUnit('1'), dEUR, { from: account2 });
									});
									it('then the source side has persisted the rate', async () => {
										assert.bnEqual(
											await exchanger.lastExchangeRate(dETH),
											toUnit((baseRate * 1.1).toString())
										);
									});
									it('and the dest side has not persisted the rate', async () => {
										assert.bnEqual(await exchanger.lastExchangeRate(dEUR), toUnit('2'));
									});

									describe('when the owner invokes resetLastExchangeRate([dEUR, dETH])', () => {
										beforeEach(async () => {
											await exchanger.resetLastExchangeRate([dEUR, dETH], { from: owner });
										});

										it('then the dEUR last exchange rate is updated to the current price', async () => {
											assert.bnEqual(await exchanger.lastExchangeRate(dEUR), toUnit('10'));
										});

										it('and the dETH rate has not changed', async () => {
											assert.bnEqual(
												await exchanger.lastExchangeRate(dETH),
												toUnit((baseRate * 1.1).toString())
											);
										});
									});
								});
							});
						});
					});

					describe('the isSynthRateInvalid() view correctly returns status', () => {
						it('when called with a synth with only a single rate, returns false', async () => {
							assert.equal(await exchanger.isSynthRateInvalid(dETH), false);
						});
						it('when called with a synth with no rate (i.e. 0), returns true', async () => {
							assert.equal(await exchanger.isSynthRateInvalid(toBytes32('XYZ')), true);
						});
						describe('when a synth rate changes outside of the range', () => {
							updateRate({ target: dETH, rate: baseRate * 2 });

							it('when called with that synth, returns true', async () => {
								assert.equal(await exchanger.isSynthRateInvalid(dETH), true);
							});

							describe('when the synth rate changes back into the range', () => {
								updateRate({ target: dETH, rate: baseRate });

								it('then when called with the target, still returns true', async () => {
									assert.equal(await exchanger.isSynthRateInvalid(dETH), true);
								});
							});
						});
						describe('when there is a last rate into dETH via an exchange', () => {
							beforeEach(async () => {
								await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account2 });
							});

							describe('when a synth rate changes outside of the range and then returns to the range', () => {
								updateRate({ target: dETH, rate: baseRate * 2 });
								updateRate({ target: dETH, rate: baseRate * 1.2 });

								it('then when called with the target, returns false', async () => {
									assert.equal(await exchanger.isSynthRateInvalid(dETH), false);
								});
							});
						});

						describe('when there is a last price out of dETH via an exchange', () => {
							beforeEach(async () => {
								await dETHContract.issue(account2, toUnit('1'));
								await dpassive.exchange(dETH, toUnit('0.001'), dUSD, { from: account2 });
							});

							describe('when a synth price changes outside of the range and then returns to the range', () => {
								updateRate({ target: dETH, rate: baseRate * 2 });
								updateRate({ target: dETH, rate: baseRate * 1.2 });

								it('then when called with the target, returns false', async () => {
									assert.equal(await exchanger.isSynthRateInvalid(dETH), false);
								});
							});
						});
					});

					describe('suspension is triggered via exchanging', () => {
						describe('given the user has some dETH', () => {
							beforeEach(async () => {
								await dETHContract.issue(account1, toUnit('1'));
							});

							const assertSpike = ({ from, to, target, factor, spikeExpected }) => {
								const rate = Math.abs(
									(factor > 0 ? baseRate * factor : baseRate / factor).toFixed(2)
								);
								describe(`when the rate of ${web3.utils.hexToAscii(
									target
								)} is ${rate} (factor: ${factor})`, () => {
									updateRate({ target, rate });

									describe(`when a user exchanges`, () => {
										let logs;

										beforeEach(async () => {
											const { tx: hash } = await dpassive.exchange(from, toUnit('0.01'), to, {
												from: account1,
											});
											logs = await getDecodedLogs({
												hash,
												contracts: [dpassive, exchanger, systemStatus],
											});
										});
										if (Math.abs(factor) >= baseFactor || spikeExpected) {
											it('then the synth is suspended', async () => {
												const { suspended, reason } = await systemStatus.synthSuspension(target);
												assert.ok(suspended);
												assert.equal(reason, '65');
											});
											it('and no exchange took place', async () => {
												assert.ok(!logs.some(({ name } = {}) => name === 'SynthExchange'));
											});
										} else {
											it('then neither synth is suspended', async () => {
												const suspensions = await Promise.all([
													systemStatus.synthSuspension(from),
													systemStatus.synthSuspension(to),
												]);
												assert.ok(!suspensions[0].suspended);
												assert.ok(!suspensions[1].suspended);
											});
											it('and an exchange took place', async () => {
												assert.ok(logs.some(({ name } = {}) => name === 'SynthExchange'));
											});
										}
									});
								});
							};

							const assertRange = ({ from, to, target }) => {
								[1, -1].forEach(multiplier => {
									describe(`${multiplier > 0 ? 'upwards' : 'downwards'} movement`, () => {
										// below threshold
										assertSpike({
											from,
											to,
											target,
											factor: 1.99 * multiplier,
										});

										// on threshold
										assertSpike({
											from,
											to,
											target,
											factor: 2 * multiplier,
										});

										// over threshold
										assertSpike({
											from,
											to,
											target,
											factor: 3 * multiplier,
										});
									});
								});
							};

							const assertBothSidesOfTheExchange = () => {
								describe('on the dest side', () => {
									assertRange({ from: dUSD, to: dETH, target: dETH });
								});

								describe('on the src side', () => {
									assertRange({ from: dETH, to: dAUD, target: dETH });
								});
							};

							describe('with no prior exchange history', () => {
								assertBothSidesOfTheExchange();

								describe('when a recent price rate is set way outside of the threshold', () => {
									beforeEach(async () => {
										await fastForward(10);
										await exchangeRates.updateRates([dETH], [toUnit('1000')], await currentTime(), {
											from: oracle,
										});
									});
									describe('and then put back to normal', () => {
										beforeEach(async () => {
											await fastForward(10);
											await exchangeRates.updateRates(
												[dETH],
												[baseRate.toString()],
												await currentTime(),
												{
													from: oracle,
												}
											);
										});
										assertSpike({
											from: dUSD,
											to: dETH,
											target: dETH,
											factor: 1,
											spikeExpected: true,
										});
									});
								});
							});

							describe('with a prior exchange from another user into the source', () => {
								beforeEach(async () => {
									await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account2 });
								});

								assertBothSidesOfTheExchange();
							});

							describe('with a prior exchange from another user out of the source', () => {
								beforeEach(async () => {
									await dETHContract.issue(account2, toUnit('1'));
									await dpassive.exchange(dETH, toUnit('1'), dAUD, { from: account2 });
								});

								assertBothSidesOfTheExchange();
							});
						});
					});

					describe('suspension invoked by anyone via suspendSynthWithInvalidRate()', () => {
						// dTRX relies on the fact that dTRX is a valid synth but never given a rate in the setup code
						// above
						const synthWithNoRate = toBytes32('dTRX');
						it('when called with invalid synth, then reverts', async () => {
							await assert.revert(
								exchanger.suspendSynthWithInvalidRate(toBytes32('XYZ')),
								'No such synth'
							);
						});
						describe('when called with a synth with no price', () => {
							let logs;
							beforeEach(async () => {
								const { tx: hash } = await exchanger.suspendSynthWithInvalidRate(synthWithNoRate);
								logs = await getDecodedLogs({
									hash,
									contracts: [dpassive, exchanger, systemStatus],
								});
							});
							it('then suspension works as expected', async () => {
								const { suspended, reason } = await systemStatus.synthSuspension(synthWithNoRate);
								assert.ok(suspended);
								assert.equal(reason, '65');
								assert.ok(logs.some(({ name }) => name === 'SynthSuspended'));
							});
						});

						describe('when the system is suspended', () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section: 'System', suspend: true });
							});
							it('then suspended a synth fails', async () => {
								await assert.revert(
									exchanger.suspendSynthWithInvalidRate(synthWithNoRate),
									'Operation prohibited'
								);
							});
							describe(`when system is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section: 'System', suspend: false });
								});
								it('then suspension works as expected', async () => {
									await exchanger.suspendSynthWithInvalidRate(synthWithNoRate);
									const { suspended, reason } = await systemStatus.synthSuspension(synthWithNoRate);
									assert.ok(suspended);
									assert.equal(reason, '65');
								});
							});
						});
					});

					describe('edge case: resetting an iSynth resets the lastExchangeRate (SIP-78)', () => {
						describe('when setInversePricing is invoked with no underlying rate', () => {
							it('it does not revert', async () => {
								await exchangeRates.setInversePricing(
									iETH,
									toUnit(4000),
									toUnit(6500),
									toUnit(1000),
									false,
									false,
									{
										from: owner,
									}
								);
							});
						});
						describe('when an iSynth is set with inverse pricing and has a price in bounds', () => {
							beforeEach(async () => {
								await exchangeRates.setInversePricing(
									iBTC,
									toUnit(4000),
									toUnit(6500),
									toUnit(1000),
									false,
									false,
									{
										from: owner,
									}
								);
							});
							// in-bounds update
							updateRate({ target: iBTC, rate: 4100 });

							describe('when a user exchanges into the iSynth', () => {
								beforeEach(async () => {
									await dpassive.exchange(dUSD, toUnit('100'), iBTC, { from: account1 });
								});
								it('then last exchange rate is correct', async () => {
									assert.bnEqual(await exchanger.lastExchangeRate(iBTC), toUnit(3900));
								});
								describe('when the inverse is reset with different limits, yielding a rate above the deviation factor', () => {
									beforeEach(async () => {
										await exchangeRates.setInversePricing(
											iBTC,
											toUnit(8000),
											toUnit(10500),
											toUnit(5000),
											false,
											false,
											{
												from: owner,
											}
										);
									});
									describe('when a user exchanges into the iSynth', () => {
										beforeEach(async () => {
											await dpassive.exchange(dUSD, toUnit('100'), iBTC, {
												from: account1,
											});
										});
										it('then the synth is not suspended', async () => {
											const { suspended } = await systemStatus.synthSuspension(iBTC);
											assert.ok(!suspended);
										});
										it('and the last exchange rate is the new rate (locked at lower limit)', async () => {
											assert.bnEqual(await exchanger.lastExchangeRate(iBTC), toUnit(10500));
										});
									});
								});
							});
						});
					});

					describe('settlement ignores deviations', () => {
						describe('when a user exchange 100 dUSD into dETH', () => {
							beforeEach(async () => {
								await dpassive.exchange(dUSD, toUnit('100'), dETH, { from: account1 });
							});
							describe('and the dETH rate moves up by a factor of 2 to 200', () => {
								updateRate({ target: dETH, rate: baseRate * 2 });

								it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
									const {
										reclaimAmount,
										rebateAmount,
										numEntries,
									} = await exchanger.settlementOwing(account1, dETH);
									assert.equal(reclaimAmount, '0');
									assert.equal(rebateAmount, '0');
									assert.equal(numEntries, '1');
								});
							});

							describe('multiple entries to settle', () => {
								describe('when the dETH rate moves down by 20%', () => {
									updateRate({ target: dETH, rate: baseRate * 0.8 });

									describe('and the waiting period expires', () => {
										beforeEach(async () => {
											// end waiting period
											await fastForward(await systemSettings.waitingPeriodSecs());
										});

										it('then settlementOwing is existing rebate with 0 reclaim, with 1 entries', async () => {
											const {
												reclaimAmount,
												rebateAmount,
												numEntries,
											} = await exchanger.settlementOwing(account1, dETH);
											assert.equal(reclaimAmount, '0');
											// some amount close to the 0.25 rebate (after fees)
											assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
											assert.equal(numEntries, '1');
										});

										describe('and the user makes another exchange into dETH', () => {
											beforeEach(async () => {
												await dpassive.exchange(dUSD, toUnit('100'), dETH, { from: account1 });
											});
											describe('and the dETH rate moves up by a factor of 2 to 200, causing the second entry to be skipped', () => {
												updateRate({ target: dETH, rate: baseRate * 2 });

												it('then settlementOwing is existing rebate with 0 reclaim, with 2 entries', async () => {
													const {
														reclaimAmount,
														rebateAmount,
														numEntries,
													} = await exchanger.settlementOwing(account1, dETH);
													assert.equal(reclaimAmount, '0');
													assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
													assert.equal(numEntries, '2');
												});
											});

											describe('and the dETH rate goes back up 25% (from 80 to 100)', () => {
												updateRate({ target: dETH, rate: baseRate });
												describe('and the waiting period expires', () => {
													beforeEach(async () => {
														// end waiting period
														await fastForward(await systemSettings.waitingPeriodSecs());
													});
													it('then settlementOwing is existing rebate, existing reclaim, and 2 entries', async () => {
														const {
															reclaimAmount,
															rebateAmount,
															numEntries,
														} = await exchanger.settlementOwing(account1, dETH);
														assert.bnClose(reclaimAmount, toUnit('0.25'), (1e16).toString());
														assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
														assert.equal(numEntries, '2');
													});
													describe('and the user makes another exchange into dETH', () => {
														beforeEach(async () => {
															await dpassive.exchange(dUSD, toUnit('100'), dETH, {
																from: account1,
															});
														});
														describe('and the dETH rate moves down by a factor of 2 to 50, causing the third entry to be skipped', () => {
															updateRate({ target: dETH, rate: baseRate * 0.5 });

															it('then settlementOwing is existing rebate and reclaim, with 3 entries', async () => {
																const {
																	reclaimAmount,
																	rebateAmount,
																	numEntries,
																} = await exchanger.settlementOwing(account1, dETH);
																assert.bnClose(reclaimAmount, toUnit('0.25'), (1e16).toString());
																assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
																assert.equal(numEntries, '3');
															});
														});
													});
												});
											});
										});
									});
								});
							});
						});

						describe('edge case: aggregator returns 0 for settlement price', () => {
							describe('when an aggregator is added to the exchangeRates', () => {
								let aggregator;

								beforeEach(async () => {
									aggregator = await MockAggregator.new({ from: owner });
									await exchangeRates.addAggregator(dETH, aggregator.address, { from: owner });
								});

								describe('and the aggregator has a rate (so the exchange succeeds)', () => {
									beforeEach(async () => {
										await aggregator.setLatestAnswer(
											convertToAggregatorPrice(100),
											await currentTime()
										);
									});
									describe('when a user exchanges out of the aggregated rate into dUSD', () => {
										beforeEach(async () => {
											// give the user some dETH
											await dETHContract.issue(account1, toUnit('1'));
											await dpassive.exchange(dETH, toUnit('1'), dUSD, { from: account1 });
										});
										describe('and the aggregated rate becomes 0', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswer('0', await currentTime());
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, dUSD);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});
											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, dUSD, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
										describe('and the aggregated rate is received but for a much higher roundId, leaving a large gap in roundIds', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswerWithRound(
													convertToAggregatorPrice(110),
													await currentTime(),
													'9999'
												);
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, dUSD);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});

											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, dUSD, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
									});
									describe('when a user exchanges into the aggregated rate from dUSD', () => {
										beforeEach(async () => {
											await dpassive.exchange(dUSD, toUnit('1'), dETH, { from: account1 });
										});
										describe('and the aggregated rate becomes 0', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswer('0', await currentTime());
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, dETH);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});
											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, dETH, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
										describe('and the aggregated rate is received but for a much higher roundId, leaving a large gap in roundIds', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswerWithRound(
													convertToAggregatorPrice(110),
													await currentTime(),
													'9999'
												);
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, dETH);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});

											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, dETH, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});
		});
	};

	const itSetsExchangeFeeRateForSynths = () => {
		describe('Given synth exchange fee rates to set', async () => {
			const fxBIPS = toUnit('0.01');
			const cryptoBIPS = toUnit('0.03');
			const empty = toBytes32('');

			describe('Given synth exchange fee rates to update', async () => {
				const newFxBIPS = toUnit('0.02');
				const newCryptoBIPS = toUnit('0.04');

				beforeEach(async () => {
					// Store multiple rates
					await systemSettings.setExchangeFeeRateForSynths(
						[dUSD, dAUD, dBTC, dETH],
						[fxBIPS, fxBIPS, cryptoBIPS, cryptoBIPS],
						{
							from: owner,
						}
					);
				});

				it('when 1 exchange rate to update then overwrite existing rate', async () => {
					await systemSettings.setExchangeFeeRateForSynths([dUSD], [newFxBIPS], {
						from: owner,
					});
					const dUSDRate = await exchanger.feeRateForExchange(empty, dUSD);
					assert.bnEqual(dUSDRate, newFxBIPS);
				});

				it('when multiple exchange rates then store them to be readable', async () => {
					// Update multiple rates
					await systemSettings.setExchangeFeeRateForSynths(
						[dUSD, dAUD, dBTC, dETH],
						[newFxBIPS, newFxBIPS, newCryptoBIPS, newCryptoBIPS],
						{
							from: owner,
						}
					);
					// Read all rates
					const dAUDRate = await exchanger.feeRateForExchange(empty, dAUD);
					assert.bnEqual(dAUDRate, newFxBIPS);
					const dUSDRate = await exchanger.feeRateForExchange(empty, dUSD);
					assert.bnEqual(dUSDRate, newFxBIPS);
					const dBTCRate = await exchanger.feeRateForExchange(empty, dBTC);
					assert.bnEqual(dBTCRate, newCryptoBIPS);
					const dETHRate = await exchanger.feeRateForExchange(empty, dETH);
					assert.bnEqual(dETHRate, newCryptoBIPS);
				});
			});
		});
	};

	describe('When using DPassive', () => {
		before(async () => {
			const VirtualSynthMastercopy = artifacts.require('VirtualSynthMastercopy');

			({
				Exchanger: exchanger,
				DPassive: dpassive,
				ExchangeRates: exchangeRates,
				ExchangeState: exchangeState,
				FeePool: feePool,
				SystemStatus: systemStatus,
				SynthdUSD: dUSDContract,
				SynthdBTC: dBTCContract,
				SynthdEUR: dEURContract,
				SynthdAUD: dAUDContract,
				SynthiBTC: iBTCContract,
				SynthdETH: dETHContract,
				SystemSettings: systemSettings,
				DelegateApprovals: delegateApprovals,
				AddressResolver: resolver,
				DebtCache: debtCache,
				Issuer: issuer,
				FlexibleStorage: flexibleStorage,
			} = await setupAllContracts({
				accounts,
				synths: ['dUSD', 'dETH', 'dEUR', 'dAUD', 'dBTC', 'iBTC', 'dTRX'],
				contracts: [
					'Exchanger',
					'ExchangeState',
					'ExchangeRates',
					'DebtCache',
					'Issuer', // necessary for dpassive transfers to succeed
					'FeePool',
					'FeePoolEternalStorage',
					'DPassive',
					'SystemStatus',
					'SystemSettings',
					'DelegateApprovals',
					'FlexibleStorage',
					'CollateralManager',
				],
				mocks: {
					// Use a real VirtualSynthMastercopy so the spec tests can interrogate deployed vSynths
					VirtualSynthMastercopy: await VirtualSynthMastercopy.new(),
				},
			}));

			// Send a price update to guarantee we're not stale.
			oracle = account1;

			amountIssued = toUnit('1000');

			// give the first two accounts 1000 dUSD each
			await dUSDContract.issue(account1, amountIssued);
			await dUSDContract.issue(account2, amountIssued);
		});

		addSnapshotBeforeRestoreAfterEach();

		beforeEach(async () => {
			timestamp = await currentTime();
			await exchangeRates.updateRates(
				[dAUD, dEUR, DPS, dETH, dBTC, iBTC],
				['0.5', '2', '1', '100', '5000', '5000'].map(toUnit),
				timestamp,
				{
					from: oracle,
				}
			);

			// set a 0.5% exchange fee rate (1/200)
			exchangeFeeRate = toUnit('0.005');
			await setExchangeFeeRateForSynths({
				owner,
				systemSettings,
				synthKeys,
				exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
			});
		});

		itReadsTheWaitingPeriod();

		itWhenTheWaitingPeriodIsZero();

		itDeviatesCorrectly();

		itCalculatesMaxSecsLeft();

		itCalculatesFeeRateForExchange();

		itCalculatesFeeRateForExchange2();

		itSettles();

		itCalculatesAmountAfterSettlement();

		itExchanges();

		itExchangesWithVirtual();

		itSetsLastExchangeRateForSynth();

		itPricesSpikeDeviation();

		itSetsExchangeFeeRateForSynths();
	});
});
