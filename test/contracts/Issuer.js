'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, mockToken } = require('./setup');

const MockEtherCollateral = artifacts.require('MockEtherCollateral');
const MockEtherWrapper = artifacts.require('MockEtherWrapper');

const {
	currentTime,
	multiplyDecimal,
	divideDecimalRound,
	divideDecimal,
	toUnit,
	fastForward,
} = require('../utils')();

const {
	setExchangeWaitingPeriod,
	setExchangeFeeRateForSynths,
	getDecodedLogs,
	decodedEventEqual,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
	defaults: { ISSUANCE_RATIO, MINIMUM_STAKE_TIME },
} = require('../..');

contract('Issuer (via DPassive)', async accounts => {
	const WEEK = 604800;

	const [dUSD, dAUD, dEUR, DPS, dETH, ETH] = ['dUSD', 'dAUD', 'dEUR', 'DPS', 'dETH', 'ETH'].map(
		toBytes32
	);
	const synthKeys = [dUSD, dAUD, dEUR, dETH, DPS];

	const [, owner, oracle, account1, account2, account3, account6] = accounts;

	let dpassive,
		systemStatus,
		systemSettings,
		dpassiveState,
		delegateApprovals,
		exchangeRates,
		feePool,
		dUSDContract,
		dETHContract,
		dEURContract,
		dAUDContract,
		escrow,
		rewardEscrowV2,
		timestamp,
		debtCache,
		issuer,
		synths,
		addressResolver;

	const getRemainingIssuableSynths = async account =>
		(await dpassive.remainingIssuableSynths(account))[0];

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {
		synths = ['dUSD', 'dAUD', 'dEUR', 'dETH'];
		({
			DPassive: dpassive,
			DPassiveState: dpassiveState,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			ExchangeRates: exchangeRates,
			DPassiveEscrow: escrow,
			RewardEscrowV2: rewardEscrowV2,
			SynthdUSD: dUSDContract,
			SynthdETH: dETHContract,
			SynthdAUD: dAUDContract,
			SynthdEUR: dEURContract,
			FeePool: feePool,
			DebtCache: debtCache,
			Issuer: issuer,
			DelegateApprovals: delegateApprovals,
			AddressResolver: addressResolver,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'DPassive',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'AddressResolver',
				'RewardEscrowV2',
				'DPassiveEscrow',
				'SystemSettings',
				'Issuer',
				'DebtCache',
				'Exchanger', // necessary for burnSynths to check settlement of dUSD
				'DelegateApprovals', // necessary for *OnBehalf functions
				'FlexibleStorage',
				'CollateralManager',
			],
		}));
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		timestamp = await currentTime();

		await exchangeRates.updateRates(
			[dAUD, dEUR, DPS, dETH],
			['0.5', '1.25', '0.1', '200'].map(toUnit),
			timestamp,
			{ from: oracle }
		);

		// set a 0.3% default exchange fee rate
		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForSynths({
			owner,
			systemSettings,
			synthKeys,
			exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
		});
		await debtCache.takeDebtSnapshot();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: issuer.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'addSynth',
				'addSynths',
				'issueSynths',
				'issueSynthsOnBehalf',
				'issueMaxSynths',
				'issueMaxSynthsOnBehalf',
				'burnSynths',
				'burnSynthsOnBehalf',
				'burnSynthsToTarget',
				'burnSynthsToTargetOnBehalf',
				'removeSynth',
				'removeSynths',
				'liquidateDelinquentAccount',
			],
		});
	});

	it('minimum stake time is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.minimumStakeTime(), MINIMUM_STAKE_TIME);
	});

	it('issuance ratio is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.issuanceRatio(), ISSUANCE_RATIO);
	});

	describe('protected methods', () => {
		it('issueSynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueSynths,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('issueSynthsOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueSynthsOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('issueMaxSynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxSynths,
				args: [account1],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('issueMaxSynthsOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxSynthsOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('burnSynths() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnSynths,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('burnSynthsOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnSynthsOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('burnSynthsToTarget() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnSynthsToTarget,
				args: [account1],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('liquidateDelinquentAccount() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.liquidateDelinquentAccount,
				args: [account1, toUnit('1'), account2],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
		it('burnSynthsToTargetOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnSynthsToTargetOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only the dpassive contract can perform this action',
			});
		});
	});

	describe('when minimum stake time is set to 0', () => {
		beforeEach(async () => {
			// set minimumStakeTime on issue and burning to 0
			await systemSettings.setMinimumStakeTime(0, { from: owner });
		});
		describe('when the issuanceRatio is 0.2', () => {
			beforeEach(async () => {
				// set default issuance ratio of 0.2
				await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
			});

			describe('minimumStakeTime - recording last issue and burn timestamp', async () => {
				let now;

				beforeEach(async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('1000'), { from: owner });

					now = await currentTime();
				});

				it('should issue synths and store issue timestamp after now', async () => {
					// issue synths
					await dpassive.issueSynths(web3.utils.toBN('5'), { from: account1 });

					// issue timestamp should be greater than now in future
					const issueTimestamp = await issuer.lastIssueEvent(owner);
					assert.ok(issueTimestamp.gte(now));
				});

				describe('require wait time on next burn synth after minting', async () => {
					it('should revert when burning any synths within minStakeTime', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(60 * 60 * 8, { from: owner });

						// issue synths first
						await dpassive.issueSynths(web3.utils.toBN('5'), { from: account1 });

						await assert.revert(
							dpassive.burnSynths(web3.utils.toBN('5'), { from: account1 }),
							'Minimum stake time not reached'
						);
					});
					it('should set minStakeTime to 120 seconds and able to burn after wait time', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(120, { from: owner });

						// issue synths first
						await dpassive.issueSynths(web3.utils.toBN('5'), { from: account1 });

						// fastForward 30 seconds
						await fastForward(10);

						await assert.revert(
							dpassive.burnSynths(web3.utils.toBN('5'), { from: account1 }),
							'Minimum stake time not reached'
						);

						// fastForward 115 seconds
						await fastForward(125);

						// burn synths
						await dpassive.burnSynths(web3.utils.toBN('5'), { from: account1 });
					});
				});
			});

			describe('totalIssuedSynths()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the synth rates
						await exchangeRates.updateRates(
							[dAUD, dEUR, dETH, ETH, DPS],
							['0.5', '1.25', '100', '100', '2'].map(toUnit),
							await currentTime(),
							{ from: oracle }
						);
						await debtCache.takeDebtSnapshot();
					});

					describe('when numerous issues in one currency', () => {
						beforeEach(async () => {
							// as our synths are mocks, let's issue some amount to users
							await dUSDContract.issue(account1, toUnit('1000'));
							await dUSDContract.issue(account2, toUnit('100'));
							await dUSDContract.issue(account3, toUnit('10'));
							await dUSDContract.issue(account1, toUnit('1'));

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('0'));
							await debtCache.takeDebtSnapshot();
						});
						it('then totalIssuedSynths in should correctly calculate the total issued synths in dUSD', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('1111'));
						});
						it('and in another synth currency', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(dAUD), toUnit('2222'));
						});
						it('and in DPS', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(DPS), divideDecimal('1111', '2'));
						});
						it('and in a non-synth currency', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(ETH), divideDecimal('1111', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								dpassive.totalIssuedSynths(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our synths are mocks, let's issue some amount to users
							await dUSDContract.issue(account1, toUnit('1000'));

							await dAUDContract.issue(account1, toUnit('1000')); // 500 dUSD worth
							await dAUDContract.issue(account2, toUnit('1000')); // 500 dUSD worth

							await dEURContract.issue(account3, toUnit('80')); // 100 dUSD worth

							await dETHContract.issue(account1, toUnit('1')); // 100 dUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('0'));
							await debtCache.takeDebtSnapshot();
						});
						it('then totalIssuedSynths in should correctly calculate the total issued synths in dUSD', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('2200'));
						});
						it('and in another synth currency', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(dAUD), toUnit('4400', '2'));
						});
						it('and in DPS', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(DPS), divideDecimal('2200', '2'));
						});
						it('and in a non-synth currency', async () => {
							assert.bnEqual(await dpassive.totalIssuedSynths(ETH), divideDecimal('2200', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								dpassive.totalIssuedSynths(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});
				});
			});

			describe('debtBalance()', () => {
				it('should not change debt balance % if exchange rates change', async () => {
					let newAUDRate = toUnit('0.5');
					let timestamp = await currentTime();
					await exchangeRates.updateRates([dAUD], [newAUDRate], timestamp, { from: oracle });
					await debtCache.takeDebtSnapshot();

					await dpassive.transfer(account1, toUnit('20000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('20000'), {
						from: owner,
					});

					const amountIssuedAcc1 = toUnit('30');
					const amountIssuedAcc2 = toUnit('50');
					await dpassive.issueSynths(amountIssuedAcc1, { from: account1 });
					await dpassive.issueSynths(amountIssuedAcc2, { from: account2 });

					await dpassive.exchange(dUSD, amountIssuedAcc2, dAUD, { from: account2 });

					const PRECISE_UNIT = web3.utils.toWei(web3.utils.toBN('1'), 'gether');
					let totalIssuedSynthdUSD = await dpassive.totalIssuedSynths(dUSD);
					const account1DebtRatio = divideDecimal(
						amountIssuedAcc1,
						totalIssuedSynthdUSD,
						PRECISE_UNIT
					);
					const account2DebtRatio = divideDecimal(
						amountIssuedAcc2,
						totalIssuedSynthdUSD,
						PRECISE_UNIT
					);

					timestamp = await currentTime();
					newAUDRate = toUnit('1.85');
					await exchangeRates.updateRates([dAUD], [newAUDRate], timestamp, { from: oracle });
					await debtCache.takeDebtSnapshot();

					totalIssuedSynthdUSD = await dpassive.totalIssuedSynths(dUSD);
					const conversionFactor = web3.utils.toBN(1000000000);
					const expectedDebtAccount1 = multiplyDecimal(
						account1DebtRatio,
						totalIssuedSynthdUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);
					const expectedDebtAccount2 = multiplyDecimal(
						account2DebtRatio,
						totalIssuedSynthdUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);

					assert.bnClose(await dpassive.debtBalanceOf(account1, dUSD), expectedDebtAccount1);
					assert.bnClose(await dpassive.debtBalanceOf(account2, dUSD), expectedDebtAccount2);
				});

				it("should correctly calculate a user's debt balance without prior issuance", async () => {
					await dpassive.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					const debt1 = await dpassive.debtBalanceOf(account1, toBytes32('dUSD'));
					const debt2 = await dpassive.debtBalanceOf(account2, toBytes32('dUSD'));
					assert.bnEqual(debt1, 0);
					assert.bnEqual(debt2, 0);
				});

				it("should correctly calculate a user's debt balance with prior issuance", async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedSynths = toUnit('1001');
					await dpassive.issueSynths(issuedSynths, { from: account1 });

					const debt = await dpassive.debtBalanceOf(account1, toBytes32('dUSD'));
					assert.bnEqual(debt, issuedSynths);
				});
			});

			describe('remainingIssuableSynths()', () => {
				it("should correctly calculate a user's remaining issuable synths with prior issuance", async () => {
					const dps2usdRate = await exchangeRates.rateForCurrency(DPS);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedDPassives = web3.utils.toBN('200012');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});

					// Issue
					const amountIssued = toUnit('2011');
					await dpassive.issueSynths(amountIssued, { from: account1 });

					const expectedIssuableSynths = multiplyDecimal(
						toUnit(issuedDPassives),
						multiplyDecimal(dps2usdRate, issuanceRatio)
					).sub(amountIssued);

					const remainingIssuable = await getRemainingIssuableSynths(account1);
					assert.bnEqual(remainingIssuable, expectedIssuableSynths);
				});

				it("should correctly calculate a user's remaining issuable synths without prior issuance", async () => {
					const dps2usdRate = await exchangeRates.rateForCurrency(DPS);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedDPassives = web3.utils.toBN('20');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});

					const expectedIssuableSynths = multiplyDecimal(
						toUnit(issuedDPassives),
						multiplyDecimal(dps2usdRate, issuanceRatio)
					);

					const remainingIssuable = await getRemainingIssuableSynths(account1);
					assert.bnEqual(remainingIssuable, expectedIssuableSynths);
				});
			});

			describe('maxIssuableSynths()', () => {
				it("should correctly calculate a user's maximum issuable synths without prior issuance", async () => {
					const rate = await exchangeRates.rateForCurrency(toBytes32('DPS'));
					const issuedDPassives = web3.utils.toBN('200000');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});
					const issuanceRatio = await systemSettings.issuanceRatio();

					const expectedIssuableSynths = multiplyDecimal(
						toUnit(issuedDPassives),
						multiplyDecimal(rate, issuanceRatio)
					);
					const maxIssuableSynths = await dpassive.maxIssuableSynths(account1);

					assert.bnEqual(expectedIssuableSynths, maxIssuableSynths);
				});

				it("should correctly calculate a user's maximum issuable synths without any DPS", async () => {
					const maxIssuableSynths = await dpassive.maxIssuableSynths(account1);
					assert.bnEqual(0, maxIssuableSynths);
				});

				it("should correctly calculate a user's maximum issuable synths with prior issuance", async () => {
					const dps2usdRate = await exchangeRates.rateForCurrency(DPS);

					const issuedDPassives = web3.utils.toBN('320001');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});

					const issuanceRatio = await systemSettings.issuanceRatio();
					const amountIssued = web3.utils.toBN('1234');
					await dpassive.issueSynths(toUnit(amountIssued), { from: account1 });

					const expectedIssuableSynths = multiplyDecimal(
						toUnit(issuedDPassives),
						multiplyDecimal(dps2usdRate, issuanceRatio)
					);

					const maxIssuableSynths = await dpassive.maxIssuableSynths(account1);
					assert.bnEqual(expectedIssuableSynths, maxIssuableSynths);
				});
			});

			describe('adding and removing synths', () => {
				it('should allow adding a Synth contract', async () => {
					const previousSynthCount = await dpassive.availableSynthCount();

					const { token: synth } = await mockToken({
						accounts,
						synth: 'dXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const txn = await issuer.addSynth(synth.address, { from: owner });

					const currencyKey = toBytes32('dXYZ');

					// Assert that we've successfully added a Synth
					assert.bnEqual(
						await dpassive.availableSynthCount(),
						previousSynthCount.add(web3.utils.toBN(1))
					);
					// Assert that it's at the end of the array
					assert.equal(await dpassive.availableSynths(previousSynthCount), synth.address);
					// Assert that it's retrievable by its currencyKey
					assert.equal(await dpassive.synths(currencyKey), synth.address);

					// Assert event emitted
					assert.eventEqual(txn.logs[0], 'SynthAdded', [currencyKey, synth.address]);
				});

				it('should disallow adding a Synth contract when the user is not the owner', async () => {
					const { token: synth } = await mockToken({
						accounts,
						synth: 'dXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await onlyGivenAddressCanInvoke({
						fnc: issuer.addSynth,
						accounts,
						args: [synth.address],
						address: owner,
						reason: 'Only the contract owner may perform this action',
					});
				});

				it('should disallow double adding a Synth contract with the same address', async () => {
					const { token: synth } = await mockToken({
						accounts,
						synth: 'dXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addSynth(synth.address, { from: owner });
					await assert.revert(issuer.addSynth(synth.address, { from: owner }), 'Synth exists');
				});

				it('should disallow double adding a Synth contract with the same currencyKey', async () => {
					const { token: synth1 } = await mockToken({
						accounts,
						synth: 'dXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const { token: synth2 } = await mockToken({
						accounts,
						synth: 'dXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addSynth(synth1.address, { from: owner });
					await assert.revert(issuer.addSynth(synth2.address, { from: owner }), 'Synth exists');
				});

				describe('when another synth is added with 0 supply', () => {
					let currencyKey, synth;

					beforeEach(async () => {
						const symbol = 'dBTC';
						currencyKey = toBytes32(symbol);

						({ token: synth } = await mockToken({
							synth: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addSynth(synth.address, { from: owner });
					});

					it('should be able to query multiple synth addresses', async () => {
						const synthAddresses = await issuer.getSynths([currencyKey, dETH, dUSD]);
						assert.equal(synthAddresses[0], synth.address);
						assert.equal(synthAddresses[1], dETHContract.address);
						assert.equal(synthAddresses[2], dUSDContract.address);
						assert.equal(synthAddresses.length, 3);
					});

					it('should allow removing a Synth contract when it has no issued balance', async () => {
						const synthCount = await dpassive.availableSynthCount();

						assert.notEqual(await dpassive.synths(currencyKey), ZERO_ADDRESS);

						const txn = await issuer.removeSynth(currencyKey, { from: owner });

						// Assert that we have one less synth, and that the specific currency key is gone.
						assert.bnEqual(
							await dpassive.availableSynthCount(),
							synthCount.sub(web3.utils.toBN(1))
						);
						assert.equal(await dpassive.synths(currencyKey), ZERO_ADDRESS);

						assert.eventEqual(txn, 'SynthRemoved', [currencyKey, synth.address]);
					});

					it('should disallow removing a token by a non-owner', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: issuer.removeSynth,
							args: [currencyKey],
							accounts,
							address: owner,
							reason: 'Only the contract owner may perform this action',
						});
					});

					describe('when that synth has issued', () => {
						beforeEach(async () => {
							await synth.issue(account1, toUnit('100'));
						});
						it('should disallow removing a Synth contract when it has an issued balance', async () => {
							// Assert that we can't remove the synth now
							await assert.revert(
								issuer.removeSynth(currencyKey, { from: owner }),
								'Synth supply exists'
							);
						});
					});
				});

				it('should disallow removing a Synth contract when requested by a non-owner', async () => {
					// Note: This test depends on state in the migration script, that there are hooked up synths
					// without balances
					await assert.revert(issuer.removeSynth(dEUR, { from: account1 }));
				});

				it('should revert when requesting to remove a non-existent synth', async () => {
					// Note: This test depends on state in the migration script, that there are hooked up synths
					// without balances
					const currencyKey = toBytes32('NOPE');

					// Assert that we can't remove the synth
					await assert.revert(issuer.removeSynth(currencyKey, { from: owner }));
				});

				it('should revert when requesting to remove dUSD', async () => {
					// Note: This test depends on state in the migration script, that there are hooked up synths
					// without balances
					const currencyKey = toBytes32('dUSD');

					// Assert that we can't remove the synth
					await assert.revert(issuer.removeSynth(currencyKey, { from: owner }));
				});

				describe('multiple add/remove synths', () => {
					let currencyKey, synth;

					beforeEach(async () => {
						const symbol = 'dBTC';
						currencyKey = toBytes32(symbol);

						({ token: synth } = await mockToken({
							synth: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addSynth(synth.address, { from: owner });
					});

					it('should allow adding multiple Synth contracts at once', async () => {
						const previousSynthCount = await dpassive.availableSynthCount();

						const { token: synth1 } = await mockToken({
							accounts,
							synth: 'dXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						const { token: synth2 } = await mockToken({
							accounts,
							synth: 'dABC',
							skipInitialAllocation: true,
							supply: 0,
							name: 'ABC',
							symbol: 'ABC',
						});

						const txn = await issuer.addSynths([synth1.address, synth2.address], { from: owner });

						const currencyKey1 = toBytes32('dXYZ');
						const currencyKey2 = toBytes32('dABC');

						// Assert that we've successfully added two Synths
						assert.bnEqual(
							await dpassive.availableSynthCount(),
							previousSynthCount.add(web3.utils.toBN(2))
						);
						// Assert that they're at the end of the array
						assert.equal(await dpassive.availableSynths(previousSynthCount), synth1.address);
						assert.equal(
							await dpassive.availableSynths(previousSynthCount.add(web3.utils.toBN(1))),
							synth2.address
						);
						// Assert that they are retrievable by currencyKey
						assert.equal(await dpassive.synths(currencyKey1), synth1.address);
						assert.equal(await dpassive.synths(currencyKey2), synth2.address);

						// Assert events emitted
						assert.eventEqual(txn.logs[0], 'SynthAdded', [currencyKey1, synth1.address]);
						assert.eventEqual(txn.logs[1], 'SynthAdded', [currencyKey2, synth2.address]);
					});

					it('should disallow adding Synth contracts if the user is not the owner', async () => {
						const { token: synth } = await mockToken({
							accounts,
							synth: 'dXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await onlyGivenAddressCanInvoke({
							fnc: issuer.addSynths,
							accounts,
							args: [[synth.address]],
							address: owner,
							reason: 'Only the contract owner may perform this action',
						});
					});

					it('should disallow multi-adding the same Synth contract', async () => {
						const { token: synth } = await mockToken({
							accounts,
							synth: 'dXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addSynths([synth.address, synth.address], { from: owner }),
							'Synth exists'
						);
					});

					it('should disallow multi-adding synth contracts with the same currency key', async () => {
						const { token: synth1 } = await mockToken({
							accounts,
							synth: 'dXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						const { token: synth2 } = await mockToken({
							accounts,
							synth: 'dXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addSynths([synth1.address, synth2.address], { from: owner }),
							'Synth exists'
						);
					});

					it('should disallow removing Synths by a non-owner', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: issuer.removeSynths,
							args: [[currencyKey]],
							accounts,
							address: owner,
							reason: 'Only the contract owner may perform this action',
						});
					});

					it('should disallow removing non-existent synths', async () => {
						const fakeCurrencyKey = toBytes32('NOPE');

						// Assert that we can't remove the synth
						await assert.revert(
							issuer.removeSynths([currencyKey, fakeCurrencyKey], { from: owner }),
							'Synth does not exist'
						);
					});

					it('should disallow removing dUSD', async () => {
						// Assert that we can't remove dUSD
						await assert.revert(
							issuer.removeSynths([currencyKey, dUSD], { from: owner }),
							'Cannot remove synth'
						);
					});

					it('should allow removing synths with no balance', async () => {
						const symbol2 = 'dFOO';
						const currencyKey2 = toBytes32(symbol2);

						const { token: synth2 } = await mockToken({
							synth: symbol2,
							accounts,
							name: 'foo',
							symbol2,
							supply: 0,
							skipInitialAllocation: true,
						});

						await issuer.addSynth(synth2.address, { from: owner });

						const previousSynthCount = await dpassive.availableSynthCount();

						const tx = await issuer.removeSynths([currencyKey, currencyKey2], { from: owner });

						assert.bnEqual(
							await dpassive.availableSynthCount(),
							previousSynthCount.sub(web3.utils.toBN(2))
						);

						// Assert events emitted
						assert.eventEqual(tx.logs[0], 'SynthRemoved', [currencyKey, synth.address]);
						assert.eventEqual(tx.logs[1], 'SynthRemoved', [currencyKey2, synth2.address]);
					});

					it('should disallow removing synths if any of them has a positive balance', async () => {
						const symbol2 = 'dFOO';
						const currencyKey2 = toBytes32(symbol2);

						const { token: synth2 } = await mockToken({
							synth: symbol2,
							accounts,
							name: 'foo',
							symbol2,
							supply: 0,
							skipInitialAllocation: true,
						});

						await issuer.addSynth(synth2.address, { from: owner });
						await synth2.issue(account1, toUnit('100'));

						await assert.revert(
							issuer.removeSynths([currencyKey, currencyKey2], { from: owner }),
							'Synth supply exists'
						);
					});
				});
			});

			describe('issuance', () => {
				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has synths to issue from
						await dpassive.transfer(account1, toUnit('1000'), { from: owner });
					});

					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling issue() reverts', async () => {
								await assert.revert(
									dpassive.issueSynths(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling issueMaxSynths() reverts', async () => {
								await assert.revert(
									dpassive.issueMaxSynths({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling issue() succeeds', async () => {
									await dpassive.issueSynths(toUnit('1'), { from: account1 });
								});
								it('and calling issueMaxSynths() succeeds', async () => {
									await dpassive.issueMaxSynths({ from: account1 });
								});
							});
						});
					});
					['DPS', 'dAUD', ['DPS', 'dAUD'], 'none'].forEach(type => {
						describe(`when ${type} is stale`, () => {
							beforeEach(async () => {
								await fastForward(
									(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
								);

								// set all rates minus those to ignore
								const ratesToUpdate = ['DPS']
									.concat(synths)
									.filter(key => key !== 'dUSD' && ![].concat(type).includes(key));

								const timestamp = await currentTime();

								await exchangeRates.updateRates(
									ratesToUpdate.map(toBytes32),
									ratesToUpdate.map(() => toUnit('1')),
									timestamp,
									{
										from: oracle,
									}
								);
								await debtCache.takeDebtSnapshot();
							});

							if (type === 'none') {
								it('then calling issueSynths succeeds', async () => {
									await dpassive.issueSynths(toUnit('1'), { from: account1 });
								});
								it('and calling issueMaxSynths() succeeds', async () => {
									await dpassive.issueMaxSynths({ from: account1 });
								});
							} else {
								it('reverts on issueSynths()', async () => {
									await assert.revert(
										dpassive.issueSynths(toUnit('1'), { from: account1 }),
										'A synth or DPS rate is invalid'
									);
								});
								it('reverts on issueMaxSynths()', async () => {
									await assert.revert(
										dpassive.issueMaxSynths({ from: account1 }),
										'A synth or DPS rate is invalid'
									);
								});
							}
						});
					});
				});
				it('should allow the issuance of a small amount of synths', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					// Note: If a too small amount of synths are issued here, the amount may be
					// rounded to 0 in the debt register. This will revert. As such, there is a minimum
					// number of synths that need to be issued each time issue is invoked. The exact
					// amount depends on the Synth exchange rate and the total supply.
					await dpassive.issueSynths(web3.utils.toBN('5'), { from: account1 });
				});

				it('should be possible to issue the maximum amount of synths via issueSynths', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('1000'), { from: owner });

					const maxSynths = await dpassive.maxIssuableSynths(account1);

					// account1 should be able to issue
					await dpassive.issueSynths(maxSynths, { from: account1 });
				});

				it('should allow an issuer to issue synths in one flavour', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					await dpassive.issueSynths(toUnit('10'), { from: account1 });

					// There should be 10 dUSD of value in the system
					assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('10'));

					// And account1 should own 100% of the debt.
					assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('10'));
					assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('10'));
				});

				// TODO: Check that the rounding errors are acceptable
				it('should allow two issuers to issue synths in one flavour', async () => {
					// Give some DPS to account1 and account2
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueSynths(toUnit('10'), { from: account1 });
					await dpassive.issueSynths(toUnit('20'), { from: account2 });

					// There should be 30dUSD of value in the system
					assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('30'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await dpassive.debtBalanceOf(account1, dUSD), toUnit('10'));
					assert.bnClose(await dpassive.debtBalanceOf(account2, dUSD), toUnit('20'));
				});

				it('should allow multi-issuance in one flavour', async () => {
					// Give some DPS to account1 and account2
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueSynths(toUnit('10'), { from: account1 });
					await dpassive.issueSynths(toUnit('20'), { from: account2 });
					await dpassive.issueSynths(toUnit('10'), { from: account1 });

					// There should be 40 dUSD of value in the system
					assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('40'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await dpassive.debtBalanceOf(account1, dUSD), toUnit('20'));
					assert.bnClose(await dpassive.debtBalanceOf(account2, dUSD), toUnit('20'));
				});

				describe('issueMaxSynths', () => {
					it('should allow an issuer to issue max synths in one flavour', async () => {
						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('10000'), {
							from: owner,
						});

						// Issue
						await dpassive.issueMaxSynths({ from: account1 });

						// There should be 200 dUSD of value in the system
						assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('200'));

						// And account1 should own all of it.
						assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('200'));
					});
				});

				it('should allow an issuer to issue max synths via the standard issue call', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Determine maximum amount that can be issued.
					const maxIssuable = await dpassive.maxIssuableSynths(account1);

					// Issue
					await dpassive.issueSynths(maxIssuable, { from: account1 });

					// There should be 200 dUSD of value in the system
					assert.bnEqual(await dpassive.totalIssuedSynths(dUSD), toUnit('200'));

					// And account1 should own all of it.
					assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('200'));
				});

				it('should disallow an issuer from issuing synths beyond their remainingIssuableSynths', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue dUSD
					const issuableSynths = await getRemainingIssuableSynths(account1);
					assert.bnEqual(issuableSynths, toUnit('200'));

					// Issue that amount.
					await dpassive.issueSynths(issuableSynths, { from: account1 });

					// They should now have 0 issuable synths.
					assert.bnEqual(await getRemainingIssuableSynths(account1), '0');

					// And trying to issue the smallest possible unit of one should fail.
					await assert.revert(dpassive.issueSynths('1', { from: account1 }), 'Amount too large');
				});
			});

			describe('burning', () => {
				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has synths to burb
						await dpassive.transfer(account1, toUnit('1000'), { from: owner });
						await dpassive.issueMaxSynths({ from: account1 });
					});
					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling burn() reverts', async () => {
								await assert.revert(
									dpassive.burnSynths(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling burnSynthsToTarget() reverts', async () => {
								await assert.revert(
									dpassive.burnSynthsToTarget({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling burnSynths() succeeds', async () => {
									await dpassive.burnSynths(toUnit('1'), { from: account1 });
								});
								it('and calling burnSynthsToTarget() succeeds', async () => {
									await dpassive.burnSynthsToTarget({ from: account1 });
								});
							});
						});
					});

					['DPS', 'dAUD', ['DPS', 'dAUD'], 'none'].forEach(type => {
						describe(`when ${type} is stale`, () => {
							beforeEach(async () => {
								await fastForward(
									(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
								);

								// set all rates minus those to ignore
								const ratesToUpdate = ['DPS']
									.concat(synths)
									.filter(key => key !== 'dUSD' && ![].concat(type).includes(key));

								const timestamp = await currentTime();

								await exchangeRates.updateRates(
									ratesToUpdate.map(toBytes32),
									ratesToUpdate.map(rate => toUnit(rate === 'DPS' ? '0.1' : '1')),
									timestamp,
									{
										from: oracle,
									}
								);
								await debtCache.takeDebtSnapshot();
							});

							if (type === 'none') {
								it('then calling burnSynths() succeeds', async () => {
									await dpassive.burnSynths(toUnit('1'), { from: account1 });
								});
								it('and calling burnSynthsToTarget() succeeds', async () => {
									await dpassive.burnSynthsToTarget({ from: account1 });
								});
							} else {
								it('then calling burn() reverts', async () => {
									await assert.revert(
										dpassive.burnSynths(toUnit('1'), { from: account1 }),
										'A synth or DPS rate is invalid'
									);
								});
								it('and calling burnSynthsToTarget() reverts', async () => {
									await assert.revert(
										dpassive.burnSynthsToTarget({ from: account1 }),
										'A synth or DPS rate is invalid'
									);
								});
							}
						});
					});
				});

				it('should allow an issuer with outstanding debt to burn synths and decrease debt', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueMaxSynths({ from: account1 });

					// account1 should now have 200 dUSD of debt.
					assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('200'));

					// Burn 100 dUSD
					await dpassive.burnSynths(toUnit('100'), { from: account1 });

					// account1 should now have 100 dUSD of debt.
					assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('100'));
				});

				it('should disallow an issuer without outstanding debt from burning synths', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueMaxSynths({ from: account1 });

					// account2 should not have anything and can't burn.
					await assert.revert(
						dpassive.burnSynths(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);

					// And even when we give account2 synths, it should not be able to burn.
					await dUSDContract.transfer(account2, toUnit('100'), {
						from: account1,
					});

					await assert.revert(
						dpassive.burnSynths(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);
				});

				it('should revert when trying to burn synths that do not exist', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueMaxSynths({ from: account1 });

					// Transfer all newly issued synths to account2
					await dUSDContract.transfer(account2, toUnit('200'), {
						from: account1,
					});

					const debtBefore = await dpassive.debtBalanceOf(account1, dUSD);

					assert.ok(!debtBefore.isNeg());

					// Burning any amount of dUSD beyond what is owned will cause a revert
					await assert.revert(
						dpassive.burnSynths('1', { from: account1 }),
						'SafeMath: subtraction overflow'
					);
				});

				it("should only burn up to a user's actual debt level", async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					const fullAmount = toUnit('210');
					const account1Payment = toUnit('10');
					const account2Payment = fullAmount.sub(account1Payment);
					await dpassive.issueSynths(account1Payment, { from: account1 });
					await dpassive.issueSynths(account2Payment, { from: account2 });

					// Transfer all of account2's synths to account1
					const amountTransferred = toUnit('200');
					await dUSDContract.transfer(account1, amountTransferred, {
						from: account2,
					});
					// return;

					const balanceOfAccount1 = await dUSDContract.balanceOf(account1);

					// Then try to burn them all. Only 10 synths (and fees) should be gone.
					await dpassive.burnSynths(balanceOfAccount1, { from: account1 });
					const balanceOfAccount1AfterBurn = await dUSDContract.balanceOf(account1);

					// Recording debts in the debt ledger reduces accuracy.
					//   Let's allow for a 1000 margin of error.
					assert.bnClose(balanceOfAccount1AfterBurn, amountTransferred, '1000');
				});

				it("should successfully burn all user's synths @gasprofile", async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueSynths(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 synths (and fees) should be gone.
					await dpassive.burnSynths(await dUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await dUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of synths', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					await dpassive.issueSynths(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 synths (and fees) should be gone.
					await dpassive.burnSynths(await dUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await dUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of synths', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedSynthsPt1 = toUnit('2000');
					const issuedSynthsPt2 = toUnit('2000');
					await dpassive.issueSynths(issuedSynthsPt1, { from: account1 });
					await dpassive.issueSynths(issuedSynthsPt2, { from: account1 });
					await dpassive.issueSynths(toUnit('1000'), { from: account2 });

					const debt = await dpassive.debtBalanceOf(account1, dUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				describe('debt calculation in multi-issuance scenarios', () => {
					it('should correctly calculate debt in a multi-issuance multi-burn scenario @gasprofile', async () => {
						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await dpassive.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await dpassive.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedSynths1 = toUnit('2000');
						const issuedSynths2 = toUnit('2000');
						const issuedSynths3 = toUnit('2000');

						// Send more than their synth balance to burn all
						const burnAllSynths = toUnit('2050');

						await dpassive.issueSynths(issuedSynths1, { from: account1 });
						await dpassive.issueSynths(issuedSynths2, { from: account2 });
						await dpassive.issueSynths(issuedSynths3, { from: account3 });

						await dpassive.burnSynths(burnAllSynths, { from: account1 });
						await dpassive.burnSynths(burnAllSynths, { from: account2 });
						await dpassive.burnSynths(burnAllSynths, { from: account3 });

						const debtBalance1After = await dpassive.debtBalanceOf(account1, dUSD);
						const debtBalance2After = await dpassive.debtBalanceOf(account2, dUSD);
						const debtBalance3After = await dpassive.debtBalanceOf(account3, dUSD);

						assert.bnEqual(debtBalance1After, '0');
						assert.bnEqual(debtBalance2After, '0');
						assert.bnEqual(debtBalance3After, '0');
					});

					it('should allow user to burn all synths issued even after other users have issued', async () => {
						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await dpassive.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await dpassive.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedSynths1 = toUnit('2000');
						const issuedSynths2 = toUnit('2000');
						const issuedSynths3 = toUnit('2000');

						await dpassive.issueSynths(issuedSynths1, { from: account1 });
						await dpassive.issueSynths(issuedSynths2, { from: account2 });
						await dpassive.issueSynths(issuedSynths3, { from: account3 });

						const debtBalanceBefore = await dpassive.debtBalanceOf(account1, dUSD);
						await dpassive.burnSynths(debtBalanceBefore, { from: account1 });
						const debtBalanceAfter = await dpassive.debtBalanceOf(account1, dUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow a user to burn up to their balance if they try too burn too much', async () => {
						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('500000'), {
							from: owner,
						});

						// Issue
						const issuedSynths1 = toUnit('10');

						await dpassive.issueSynths(issuedSynths1, { from: account1 });
						await dpassive.burnSynths(issuedSynths1.add(toUnit('9000')), {
							from: account1,
						});
						const debtBalanceAfter = await dpassive.debtBalanceOf(account1, dUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow users to burn their debt and adjust the debtBalanceOf correctly for remaining users', async () => {
						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('40000000'), {
							from: owner,
						});
						await dpassive.transfer(account2, toUnit('40000000'), {
							from: owner,
						});

						// Issue
						const issuedSynths1 = toUnit('150000');
						const issuedSynths2 = toUnit('50000');

						await dpassive.issueSynths(issuedSynths1, { from: account1 });
						await dpassive.issueSynths(issuedSynths2, { from: account2 });

						let debtBalance1After = await dpassive.debtBalanceOf(account1, dUSD);
						let debtBalance2After = await dpassive.debtBalanceOf(account2, dUSD);

						// debtBalanceOf has rounding error but is within tolerance
						assert.bnClose(debtBalance1After, toUnit('150000'));
						assert.bnClose(debtBalance2After, toUnit('50000'));

						// Account 1 burns 100,000
						await dpassive.burnSynths(toUnit('100000'), { from: account1 });

						debtBalance1After = await dpassive.debtBalanceOf(account1, dUSD);
						debtBalance2After = await dpassive.debtBalanceOf(account2, dUSD);

						assert.bnClose(debtBalance1After, toUnit('50000'));
						assert.bnClose(debtBalance2After, toUnit('50000'));
					});

					it('should revert if sender tries to issue synths with 0 amount', async () => {
						// Issue 0 amount of synth
						const issuedSynths1 = toUnit('0');

						await assert.revert(
							dpassive.issueSynths(issuedSynths1, { from: account1 }),
							'SafeMath: division by zero'
						);
					});
				});

				describe('burnSynthsToTarget', () => {
					beforeEach(async () => {
						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('40000'), {
							from: owner,
						});
						// Set DPS price to 1
						await exchangeRates.updateRates([DPS], ['1'].map(toUnit), timestamp, {
							from: oracle,
						});
						await debtCache.takeDebtSnapshot();
						// Issue
						await dpassive.issueMaxSynths({ from: account1 });
						assert.bnClose(await dpassive.debtBalanceOf(account1, dUSD), toUnit('8000'));

						// Set minimumStakeTime to 1 hour
						await systemSettings.setMinimumStakeTime(60 * 60, { from: owner });
					});

					describe('when the DPS price drops 50%', () => {
						let maxIssuableSynths;
						beforeEach(async () => {
							await exchangeRates.updateRates([DPS], ['.5'].map(toUnit), timestamp, {
								from: oracle,
							});
							await debtCache.takeDebtSnapshot();
							maxIssuableSynths = await dpassive.maxIssuableSynths(account1);
							assert.equal(await feePool.isFeesClaimable(account1), false);
						});

						it('then the maxIssuableSynths drops 50%', async () => {
							assert.bnClose(maxIssuableSynths, toUnit('4000'));
						});
						it('then calling burnSynthsToTarget() reduces dUSD to c-ratio target', async () => {
							await dpassive.burnSynthsToTarget({ from: account1 });
							assert.bnClose(await dpassive.debtBalanceOf(account1, dUSD), toUnit('4000'));
						});
						it('then fees are claimable', async () => {
							await dpassive.burnSynthsToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the DPS price drops 10%', () => {
						let maxIssuableSynths;
						beforeEach(async () => {
							await exchangeRates.updateRates([DPS], ['.9'].map(toUnit), timestamp, {
								from: oracle,
							});
							await debtCache.takeDebtSnapshot();
							maxIssuableSynths = await dpassive.maxIssuableSynths(account1);
						});

						it('then the maxIssuableSynths drops 10%', async () => {
							assert.bnEqual(maxIssuableSynths, toUnit('7200'));
						});
						it('then calling burnSynthsToTarget() reduces dUSD to c-ratio target', async () => {
							await dpassive.burnSynthsToTarget({ from: account1 });
							assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('7200'));
						});
						it('then fees are claimable', async () => {
							await dpassive.burnSynthsToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the DPS price drops 90%', () => {
						let maxIssuableSynths;
						beforeEach(async () => {
							await exchangeRates.updateRates([DPS], ['.1'].map(toUnit), timestamp, {
								from: oracle,
							});
							await debtCache.takeDebtSnapshot();
							maxIssuableSynths = await dpassive.maxIssuableSynths(account1);
						});

						it('then the maxIssuableSynths drops 10%', async () => {
							assert.bnEqual(maxIssuableSynths, toUnit('800'));
						});
						it('then calling burnSynthsToTarget() reduces dUSD to c-ratio target', async () => {
							await dpassive.burnSynthsToTarget({ from: account1 });
							assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('800'));
						});
						it('then fees are claimable', async () => {
							await dpassive.burnSynthsToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the DPS price increases 100%', () => {
						let maxIssuableSynths;
						beforeEach(async () => {
							await exchangeRates.updateRates([DPS], ['2'].map(toUnit), timestamp, {
								from: oracle,
							});
							await debtCache.takeDebtSnapshot();
							maxIssuableSynths = await dpassive.maxIssuableSynths(account1);
						});

						it('then the maxIssuableSynths increases 100%', async () => {
							assert.bnEqual(maxIssuableSynths, toUnit('16000'));
						});
						it('then calling burnSynthsToTarget() reverts', async () => {
							await assert.revert(
								dpassive.burnSynthsToTarget({ from: account1 }),
								'SafeMath: subtraction overflow'
							);
						});
					});
				});

				describe('burnSynths() after exchange()', () => {
					describe('given the waiting period is set to 60s', () => {
						let amount;
						const exchangeFeeRate = toUnit('0');
						beforeEach(async () => {
							amount = toUnit('1250');
							await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });

							// set the exchange fee to 0 to effectively ignore it
							await setExchangeFeeRateForSynths({
								owner,
								systemSettings,
								synthKeys,
								exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
							});
						});
						describe('and a user has 1250 dUSD issued', () => {
							beforeEach(async () => {
								await dpassive.transfer(account1, toUnit('1000000'), { from: owner });
								await dpassive.issueSynths(amount, { from: account1 });
							});
							describe('and is has been exchanged into dEUR at a rate of 1.25:1 and the waiting period has expired', () => {
								beforeEach(async () => {
									await dpassive.exchange(dUSD, amount, dEUR, { from: account1 });
									await fastForward(90); // make sure the waiting period is expired on this
								});
								describe('and they have exchanged all of it back into dUSD', () => {
									beforeEach(async () => {
										await dpassive.exchange(dEUR, toUnit('1000'), dUSD, { from: account1 });
									});
									describe('when they attempt to burn the dUSD', () => {
										it('then it fails as the waiting period is ongoing', async () => {
											await assert.revert(
												dpassive.burnSynths(amount, { from: account1 }),
												'Cannot settle during waiting period'
											);
										});
									});
									describe('and 60s elapses with no change in the dEUR rate', () => {
										beforeEach(async () => {
											fastForward(60);
										});
										describe('when they attempt to burn the dUSD', () => {
											let txn;
											beforeEach(async () => {
												txn = await dpassive.burnSynths(amount, { from: account1 });
											});
											it('then it succeeds and burns the entire dUSD amount', async () => {
												const logs = await getDecodedLogs({
													hash: txn.tx,
													contracts: [dpassive, dUSDContract],
												});

												decodedEventEqual({
													event: 'Burned',
													emittedFrom: dUSDContract.address,
													args: [account1, amount],
													log: logs.find(({ name } = {}) => name === 'Burned'),
												});

												const dUSDBalance = await dUSDContract.balanceOf(account1);
												assert.equal(dUSDBalance, '0');

												const debtBalance = await dpassive.debtBalanceOf(account1, dUSD);
												assert.equal(debtBalance, '0');
											});
										});
									});
									describe('and the dEUR price decreases by 20% to 1', () => {
										beforeEach(async () => {
											await exchangeRates.updateRates([dEUR], ['1'].map(toUnit), timestamp, {
												from: oracle,
											});
											await debtCache.takeDebtSnapshot();
										});
										describe('and 60s elapses', () => {
											beforeEach(async () => {
												fastForward(60);
											});
											describe('when they attempt to burn the entire amount dUSD', () => {
												let txn;
												beforeEach(async () => {
													txn = await dpassive.burnSynths(amount, { from: account1 });
												});
												it('then it succeeds and burns their dUSD minus the reclaim amount from settlement', async () => {
													const logs = await getDecodedLogs({
														hash: txn.tx,
														contracts: [dpassive, dUSDContract],
													});

													decodedEventEqual({
														event: 'Burned',
														emittedFrom: dUSDContract.address,
														args: [account1, amount.sub(toUnit('250'))],
														log: logs
															.reverse()
															.filter(l => !!l)
															.find(({ name }) => name === 'Burned'),
													});

													const dUSDBalance = await dUSDContract.balanceOf(account1);
													assert.equal(dUSDBalance, '0');
												});
												it('and their debt balance is now 0 because they are the only debt holder in the system', async () => {
													// the debt balance remaining is what was reclaimed from the exchange
													const debtBalance = await dpassive.debtBalanceOf(account1, dUSD);
													// because this user is the only one holding debt, when we burn 250 dUSD in a reclaim,
													// it removes it from the totalIssuedSynths and
													assert.equal(debtBalance, '0');
												});
											});
											describe('when another user also has the same amount of debt', () => {
												beforeEach(async () => {
													await dpassive.transfer(account2, toUnit('1000000'), { from: owner });
													await dpassive.issueSynths(amount, { from: account2 });
												});
												describe('when the first user attempts to burn the entire amount dUSD', () => {
													let txn;
													beforeEach(async () => {
														txn = await dpassive.burnSynths(amount, { from: account1 });
													});
													it('then it succeeds and burns their dUSD minus the reclaim amount from settlement', async () => {
														const logs = await getDecodedLogs({
															hash: txn.tx,
															contracts: [dpassive, dUSDContract],
														});

														decodedEventEqual({
															event: 'Burned',
															emittedFrom: dUSDContract.address,
															args: [account1, amount.sub(toUnit('250'))],
															log: logs
																.reverse()
																.filter(l => !!l)
																.find(({ name }) => name === 'Burned'),
														});

														const dUSDBalance = await dUSDContract.balanceOf(account1);
														assert.equal(dUSDBalance, '0');
													});
													it('and their debt balance is now half of the reclaimed balance because they owe half of the pool', async () => {
														// the debt balance remaining is what was reclaimed from the exchange
														const debtBalance = await dpassive.debtBalanceOf(account1, dUSD);
														// because this user is holding half the debt, when we burn 250 dUSD in a reclaim,
														// it removes it from the totalIssuedSynths and so both users have half of 250
														// in owing synths
														assert.bnEqual(debtBalance, divideDecimal('250', 2));
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

			describe('debt calculation in multi-issuance scenarios', () => {
				it('should correctly calculate debt in a multi-issuance scenario', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedSynthsPt1 = toUnit('2000');
					const issuedSynthsPt2 = toUnit('2000');
					await dpassive.issueSynths(issuedSynthsPt1, { from: account1 });
					await dpassive.issueSynths(issuedSynthsPt2, { from: account1 });
					await dpassive.issueSynths(toUnit('1000'), { from: account2 });

					const debt = await dpassive.debtBalanceOf(account1, dUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				it('should correctly calculate debt in a multi-issuance multi-burn scenario', async () => {
					// Give some DPS to account1
					await dpassive.transfer(account1, toUnit('500000'), {
						from: owner,
					});
					await dpassive.transfer(account2, toUnit('14000'), {
						from: owner,
					});

					// Issue
					const issuedSynthsPt1 = toUnit('2000');
					const burntSynthsPt1 = toUnit('1500');
					const issuedSynthsPt2 = toUnit('1600');
					const burntSynthsPt2 = toUnit('500');

					await dpassive.issueSynths(issuedSynthsPt1, { from: account1 });
					await dpassive.burnSynths(burntSynthsPt1, { from: account1 });
					await dpassive.issueSynths(issuedSynthsPt2, { from: account1 });

					await dpassive.issueSynths(toUnit('100'), { from: account2 });
					await dpassive.issueSynths(toUnit('51'), { from: account2 });
					await dpassive.burnSynths(burntSynthsPt2, { from: account1 });

					const debt = await dpassive.debtBalanceOf(account1, toBytes32('dUSD'));
					const expectedDebt = issuedSynthsPt1
						.add(issuedSynthsPt2)
						.sub(burntSynthsPt1)
						.sub(burntSynthsPt2);

					assert.bnClose(debt, expectedDebt);
				});

				it("should allow me to burn all synths I've issued when there are other issuers", async () => {
					const totalSupply = await dpassive.totalSupply();
					const account2DPassives = toUnit('120000');
					const account1DPassives = totalSupply.sub(account2DPassives);

					await dpassive.transfer(account1, account1DPassives, {
						from: owner,
					}); // Issue the massive majority to account1
					await dpassive.transfer(account2, account2DPassives, {
						from: owner,
					}); // Issue a small amount to account2

					// Issue from account1
					const account1AmountToIssue = await dpassive.maxIssuableSynths(account1);
					await dpassive.issueMaxSynths({ from: account1 });
					const debtBalance1 = await dpassive.debtBalanceOf(account1, dUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					// Issue and burn from account 2 all debt
					await dpassive.issueSynths(toUnit('43'), { from: account2 });
					let debt = await dpassive.debtBalanceOf(account2, dUSD);
					await dpassive.burnSynths(toUnit('43'), { from: account2 });
					debt = await dpassive.debtBalanceOf(account2, dUSD);

					assert.bnEqual(debt, 0);

					// Should set user issuanceData to 0 debtOwnership and retain debtEntryIndex of last action
					assert.deepEqual(await dpassiveState.issuanceData(account2), {
						initialDebtOwnership: 0,
						debtEntryIndex: 2,
					});
				});
			});

			// These tests take a long time to run
			// ****************************************
			describe('multiple issue and burn scenarios', () => {
				it('should correctly calculate debt in a high issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await dpassive.totalSupply();
					const account2DPassives = toUnit('120000');
					const account1DPassives = totalSupply.sub(account2DPassives);

					await dpassive.transfer(account1, account1DPassives, {
						from: owner,
					}); // Issue the massive majority to account1
					await dpassive.transfer(account2, account2DPassives, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await dpassive.maxIssuableSynths(account1);
					await dpassive.issueMaxSynths({ from: account1 });
					const debtBalance1 = await dpassive.debtBalanceOf(account1, dUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit('43');
						await dpassive.issueSynths(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(4, 14)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await dpassive.burnSynths(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await dpassive.debtBalanceOf(account2, dUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await dpassive.debtBalanceOf(account2, dUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high (random) issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await dpassive.totalSupply();
					const account2DPassives = toUnit('120000');
					const account1DPassives = totalSupply.sub(account2DPassives);

					await dpassive.transfer(account1, account1DPassives, {
						from: owner,
					}); // Issue the massive majority to account1
					await dpassive.transfer(account2, account2DPassives, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await dpassive.maxIssuableSynths(account1);
					await dpassive.issueMaxSynths({ from: account1 });
					const debtBalance1 = await dpassive.debtBalanceOf(account1, dUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit(web3.utils.toBN(getRandomInt(40, 49)));
						await dpassive.issueSynths(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(37, 46)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await dpassive.burnSynths(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await dpassive.debtBalanceOf(account2, dUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await dpassive.debtBalanceOf(account2, dUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high volume contrast issuance and burn scenario', async () => {
					const totalSupply = await dpassive.totalSupply();

					// Give only 100 DPassive to account2
					const account2DPassives = toUnit('100');

					// Give the vast majority to account1 (ie. 99,999,900)
					const account1DPassives = totalSupply.sub(account2DPassives);

					await dpassive.transfer(account1, account1DPassives, {
						from: owner,
					}); // Issue the massive majority to account1
					await dpassive.transfer(account2, account2DPassives, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await dpassive.maxIssuableSynths(account1);
					await dpassive.issueMaxSynths({ from: account1 });
					const debtBalance1 = await dpassive.debtBalanceOf(account1, dUSD);
					assert.bnEqual(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						const amount = toUnit('0.000000000000000002');
						await dpassive.issueSynths(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);
					}
					const debtBalance2 = await dpassive.debtBalanceOf(account2, dUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
					assert.bnClose(debtBalance2, expectedDebtForAccount2, variance);
				}).timeout(60e3);
			});

			// ****************************************

			it("should prevent more issuance if the user's collaterisation changes to be insufficient", async () => {
				// Set dEUR for purposes of this test
				const timestamp1 = await currentTime();
				await exchangeRates.updateRates([dEUR], [toUnit('0.75')], timestamp1, { from: oracle });
				await debtCache.takeDebtSnapshot();

				const issuedDPassives = web3.utils.toBN('200000');
				await dpassive.transfer(account1, toUnit(issuedDPassives), {
					from: owner,
				});

				const maxIssuableSynths = await dpassive.maxIssuableSynths(account1);

				// Issue
				const synthsToNotIssueYet = web3.utils.toBN('2000');
				const issuedSynths = maxIssuableSynths.sub(synthsToNotIssueYet);
				await dpassive.issueSynths(issuedSynths, { from: account1 });

				// exchange into dEUR
				await dpassive.exchange(dUSD, issuedSynths, dEUR, { from: account1 });

				// Increase the value of dEUR relative to dpassive
				const timestamp2 = await currentTime();
				await exchangeRates.updateRates([dEUR], [toUnit('1.10')], timestamp2, { from: oracle });
				await debtCache.takeDebtSnapshot();

				await assert.revert(
					dpassive.issueSynths(synthsToNotIssueYet, { from: account1 }),
					'Amount too large'
				);
			});

			// Check user's collaterisation ratio

			describe('check collaterisation ratio', () => {
				const duration = 52 * WEEK;
				beforeEach(async () => {
					// setup rewardEscrowV2 with mocked feePool address
					await addressResolver.importAddresses([toBytes32('FeePool')], [account6], {
						from: owner,
					});

					// update the cached addresses
					await rewardEscrowV2.rebuildCache({ from: owner });
				});
				it('should return 0 if user has no dpassive when checking the collaterisation ratio', async () => {
					const ratio = await dpassive.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('Any user can check the collaterisation ratio for a user', async () => {
					const issuedDPassives = web3.utils.toBN('320000');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});

					// Issue
					const issuedSynths = toUnit(web3.utils.toBN('6400'));
					await dpassive.issueSynths(issuedSynths, { from: account1 });

					await dpassive.collateralisationRatio(account1, { from: account2 });
				});

				it('should be able to read collaterisation ratio for a user with dpassive but no debt', async () => {
					const issuedDPassives = web3.utils.toBN('30000');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});

					const ratio = await dpassive.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('should be able to read collaterisation ratio for a user with dpassive and debt', async () => {
					const issuedDPassives = web3.utils.toBN('320000');
					await dpassive.transfer(account1, toUnit(issuedDPassives), {
						from: owner,
					});

					// Issue
					const issuedSynths = toUnit(web3.utils.toBN('6400'));
					await dpassive.issueSynths(issuedSynths, { from: account1 });

					const ratio = await dpassive.collateralisationRatio(account1, { from: account2 });
					assert.unitEqual(ratio, '0.2');
				});

				it("should include escrowed dpassive when calculating a user's collaterisation ratio", async () => {
					const dps2usdRate = await exchangeRates.rateForCurrency(DPS);
					const transferredDPassives = toUnit('60000');
					await dpassive.transfer(account1, transferredDPassives, {
						from: owner,
					});

					// Setup escrow
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedDPassives = toUnit('30000');
					await dpassive.transfer(escrow.address, escrowedDPassives, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedDPassives,
						{
							from: owner,
						}
					);

					// Issue
					const maxIssuable = await dpassive.maxIssuableSynths(account1);
					await dpassive.issueSynths(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await dpassive.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(escrowedDPassives.add(transferredDPassives), dps2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it("should include escrowed reward dpassive when calculating a user's collateralisation ratio", async () => {
					const dps2usdRate = await exchangeRates.rateForCurrency(DPS);
					const transferredDPassives = toUnit('60000');
					await dpassive.transfer(account1, transferredDPassives, {
						from: owner,
					});

					const escrowedDPassives = toUnit('30000');
					await dpassive.transfer(rewardEscrowV2.address, escrowedDPassives, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedDPassives, duration, {
						from: account6,
					});

					// Issue
					const maxIssuable = await dpassive.maxIssuableSynths(account1);
					await dpassive.issueSynths(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await dpassive.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(escrowedDPassives.add(transferredDPassives), dps2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it('should permit user to issue dUSD debt with only escrowed DPS as collateral (no DPS in wallet)', async () => {
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();

					// ensure collateral of account1 is empty
					let collateral = await dpassive.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no DPS balance
					const dpsBalance = await dpassive.balanceOf(account1);
					assert.bnEqual(dpsBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await dpassive.transfer(escrow.address, escrowedAmount, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedAmount,
						{
							from: owner,
						}
					);

					// collateral should include escrowed amount
					collateral = await dpassive.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max synths. (300 dUSD)
					await dpassive.issueMaxSynths({ from: account1 });

					// There should be 300 dUSD of value for account1
					assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('300'));
				});

				it('should permit user to issue dUSD debt with only reward escrow as collateral (no DPS in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await dpassive.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no DPS balance
					const dpsBalance = await dpassive.balanceOf(account1);
					assert.bnEqual(dpsBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await dpassive.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral now should include escrowed amount
					collateral = await dpassive.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max synths. (300 dUSD)
					await dpassive.issueMaxSynths({ from: account1 });

					// There should be 300 dUSD of value for account1
					assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), toUnit('300'));
				});

				it("should permit anyone checking another user's collateral", async () => {
					const amount = toUnit('60000');
					await dpassive.transfer(account1, amount, { from: owner });
					const collateral = await dpassive.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should include escrowed dpassive when checking a user's collateral", async () => {
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedAmount = toUnit('15000');
					await dpassive.transfer(escrow.address, escrowedAmount, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedAmount,
						{
							from: owner,
						}
					);

					const amount = toUnit('60000');
					await dpassive.transfer(account1, amount, { from: owner });
					const collateral = await dpassive.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount.add(escrowedAmount));
				});

				it("should include escrowed reward dpassive when checking a user's collateral", async () => {
					const escrowedAmount = toUnit('15000');
					await dpassive.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});
					const amount = toUnit('60000');
					await dpassive.transfer(account1, amount, { from: owner });
					const collateral = await dpassive.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount.add(escrowedAmount));
				});

				it("should calculate a user's remaining issuable synths", async () => {
					const transferredDPassives = toUnit('60000');
					await dpassive.transfer(account1, transferredDPassives, {
						from: owner,
					});

					// Issue
					const maxIssuable = await dpassive.maxIssuableSynths(account1);
					const issued = maxIssuable.div(web3.utils.toBN(3));
					await dpassive.issueSynths(issued, { from: account1 });
					const expectedRemaining = maxIssuable.sub(issued);
					const remaining = await getRemainingIssuableSynths(account1);
					assert.bnEqual(expectedRemaining, remaining);
				});

				it("should correctly calculate a user's max issuable synths with escrowed dpassive", async () => {
					const dps2usdRate = await exchangeRates.rateForCurrency(DPS);
					const transferredDPassives = toUnit('60000');
					await dpassive.transfer(account1, transferredDPassives, {
						from: owner,
					});

					// Setup escrow
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedDPassives = toUnit('30000');
					await dpassive.transfer(escrow.address, escrowedDPassives, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedDPassives,
						{
							from: owner,
						}
					);

					const maxIssuable = await dpassive.maxIssuableSynths(account1);
					// await dpassive.issueSynths(maxIssuable, { from: account1 });

					// Compare
					const issuanceRatio = await systemSettings.issuanceRatio();
					const expectedMaxIssuable = multiplyDecimal(
						multiplyDecimal(escrowedDPassives.add(transferredDPassives), dps2usdRate),
						issuanceRatio
					);
					assert.bnEqual(maxIssuable, expectedMaxIssuable);
				});
			});

			describe('issue and burn on behalf', async () => {
				const authoriser = account1;
				const delegate = account2;

				beforeEach(async () => {
					// Assign the authoriser DPS
					await dpassive.transfer(authoriser, toUnit('20000'), {
						from: owner,
					});
					await exchangeRates.updateRates([DPS], ['1'].map(toUnit), timestamp, { from: oracle });
					await debtCache.takeDebtSnapshot();
				});
				describe('when not approved it should revert on', async () => {
					it('issueMaxSynthsOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: dpassive.issueMaxSynthsOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('issueSynthsOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: dpassive.issueSynthsOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnSynthsOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: dpassive.burnSynthsOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnSynthsToTargetOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: dpassive.burnSynthsToTargetOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
				});

				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							// ensure user has synths to burn
							await dpassive.issueSynths(toUnit('1000'), { from: authoriser });
							await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
							await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling issueSynthsOnBehalf() reverts', async () => {
							await assert.revert(
								dpassive.issueSynthsOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling issueMaxSynthsOnBehalf() reverts', async () => {
							await assert.revert(
								dpassive.issueMaxSynthsOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnSynthsOnBehalf() reverts', async () => {
							await assert.revert(
								dpassive.burnSynthsOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnSynthsToTargetOnBehalf() reverts', async () => {
							await assert.revert(
								dpassive.burnSynthsToTargetOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});

						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling issueSynthsOnBehalf() succeeds', async () => {
								await dpassive.issueSynthsOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling issueMaxSynthsOnBehalf() succeeds', async () => {
								await dpassive.issueMaxSynthsOnBehalf(authoriser, { from: delegate });
							});
							it('and calling burnSynthsOnBehalf() succeeds', async () => {
								await dpassive.burnSynthsOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling burnSynthsToTargetOnBehalf() succeeds', async () => {
								// need the user to be undercollaterized for this to succeed
								await exchangeRates.updateRates([DPS], ['0.001'].map(toUnit), timestamp, {
									from: oracle,
								});
								await debtCache.takeDebtSnapshot();
								await dpassive.burnSynthsToTargetOnBehalf(authoriser, { from: delegate });
							});
						});
					});
				});

				it('should approveIssueOnBehalf for account1', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canIssueFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveBurnOnBehalf for account1', async () => {
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canBurnFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveIssueOnBehalf and IssueMaxSynths', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					const dUSDBalanceBefore = await dUSDContract.balanceOf(account1);
					const issuableSynths = await dpassive.maxIssuableSynths(account1);

					await dpassive.issueMaxSynthsOnBehalf(authoriser, { from: delegate });
					const dUSDBalanceAfter = await dUSDContract.balanceOf(account1);
					assert.bnEqual(dUSDBalanceAfter, dUSDBalanceBefore.add(issuableSynths));
				});
				it('should approveIssueOnBehalf and IssueSynths', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					await dpassive.issueSynthsOnBehalf(authoriser, toUnit('100'), { from: delegate });

					const dUSDBalance = await dUSDContract.balanceOf(account1);
					assert.bnEqual(dUSDBalance, toUnit('100'));
				});
				it('should approveBurnOnBehalf and BurnSynths', async () => {
					await dpassive.issueMaxSynths({ from: authoriser });
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					const dUSDBalanceBefore = await dUSDContract.balanceOf(account1);
					await dpassive.burnSynthsOnBehalf(authoriser, dUSDBalanceBefore, { from: delegate });

					const dUSDBalance = await dUSDContract.balanceOf(account1);
					assert.bnEqual(dUSDBalance, toUnit('0'));
				});
				it('should approveBurnOnBehalf and burnSynthsToTarget', async () => {
					await dpassive.issueMaxSynths({ from: authoriser });
					await exchangeRates.updateRates([DPS], ['0.01'].map(toUnit), timestamp, { from: oracle });
					await debtCache.takeDebtSnapshot();

					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					await dpassive.burnSynthsToTargetOnBehalf(authoriser, { from: delegate });

					const dUSDBalanceAfter = await dUSDContract.balanceOf(account1);
					assert.bnEqual(dUSDBalanceAfter, toUnit('40'));
				});
			});

			describe('when etherCollateral is set', async () => {
				const collateralKey = 'EtherCollateral';

				it('should have zero totalIssuedSynths', async () => {
					// totalIssuedSynthsExcludeEtherCollateral equal totalIssuedSynths
					assert.bnEqual(
						await dpassive.totalIssuedSynths(dUSD),
						await dpassive.totalIssuedSynthsExcludeEtherCollateral(dUSD)
					);
				});
				describe('creating a loan on etherCollateral to issue dETH', async () => {
					let etherCollateral;
					beforeEach(async () => {
						// mock etherCollateral
						etherCollateral = await MockEtherCollateral.new({ from: owner });
						// have the owner simulate being MultiCollateral so we can invoke issue and burn
						await addressResolver.importAddresses(
							[toBytes32(collateralKey)],
							[etherCollateral.address],
							{ from: owner }
						);

						// ensure Issuer and DebtCache has the latest EtherCollateral
						await issuer.rebuildCache();
						await debtCache.rebuildCache();

						// Give some DPS to account1
						await dpassive.transfer(account1, toUnit('1000'), { from: owner });

						// account1 should be able to issue
						await dpassive.issueSynths(toUnit('10'), { from: account1 });
						// set owner as DPassive on resolver to allow issuing by owner
						await addressResolver.importAddresses([toBytes32('DPassive')], [owner], {
							from: owner,
						});
					});

					it('should be able to exclude dETH issued by ether Collateral from totalIssuedSynths', async () => {
						const totalSupplyBefore = await dpassive.totalIssuedSynths(dETH);

						// issue dETH
						const amountToIssue = toUnit('10');
						await dETHContract.issue(account1, amountToIssue, { from: owner });
						// openLoan of same amount on Ether Collateral
						await etherCollateral.openLoan(amountToIssue, { from: owner });
						// totalSupply of synths should exclude Ether Collateral issued synths
						assert.bnEqual(
							totalSupplyBefore,
							await dpassive.totalIssuedSynthsExcludeEtherCollateral(dETH)
						);

						// totalIssuedSynths after includes amount issued
						assert.bnEqual(
							await dpassive.totalIssuedSynths(dETH),
							totalSupplyBefore.add(amountToIssue)
						);
					});

					it('should exclude dETH issued by ether Collateral from debtBalanceOf', async () => {
						// account1 should own 100% of the debt.
						const debtBefore = await dpassive.debtBalanceOf(account1, dUSD);
						assert.bnEqual(debtBefore, toUnit('10'));

						// issue dETH to mimic loan
						const amountToIssue = toUnit('10');
						await dETHContract.issue(account1, amountToIssue, { from: owner });
						await etherCollateral.openLoan(amountToIssue, { from: owner });

						// After account1 owns 100% of dUSD debt.
						assert.bnEqual(
							await dpassive.totalIssuedSynthsExcludeEtherCollateral(dUSD),
							toUnit('10')
						);
						assert.bnEqual(await dpassive.debtBalanceOf(account1, dUSD), debtBefore);
					});
				});
			});

			describe('when EtherWrapper is set', async () => {
				it('should have zero totalIssuedSynths', async () => {
					assert.bnEqual(
						await dpassive.totalIssuedSynths(dUSD),
						await dpassive.totalIssuedSynthsExcludeEtherCollateral(dUSD)
					);
				});
				describe('depositing WETH on the EtherWrapper to issue dETH', async () => {
					let etherWrapper;
					beforeEach(async () => {
						// mock etherWrapper
						etherWrapper = await MockEtherWrapper.new({ from: owner });
						await addressResolver.importAddresses(
							[toBytes32('EtherWrapper')],
							[etherWrapper.address],
							{ from: owner }
						);

						// ensure DebtCache has the latest EtherWrapper
						await debtCache.rebuildCache();
					});

					it('should be able to exclude dETH issued by EtherWrapper from totalIssuedSynths', async () => {
						const totalSupplyBefore = await dpassive.totalIssuedSynths(dETH);

						const amount = toUnit('10');

						await etherWrapper.setTotalIssuedSynths(amount, { from: account1 });

						// totalSupply of synths should exclude EtherWrapper issued dETH
						assert.bnEqual(
							totalSupplyBefore,
							await dpassive.totalIssuedSynthsExcludeEtherCollateral(dETH)
						);

						// totalIssuedSynths after includes amount issued
						const { rate } = await exchangeRates.rateAndInvalid(dETH);
						assert.bnEqual(
							await dpassive.totalIssuedSynths(dETH),
							totalSupplyBefore.add(divideDecimalRound(amount, rate))
						);
					});
				});
			});
		});
	});
});
