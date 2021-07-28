'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { smockit } = require('@eth-optimism/smock');

require('./common'); // import common test scaffolding

const { setupContract, setupAllContracts } = require('./setup');

const { currentTime, fastForward, toUnit } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	updateRatesWithDefaults,
	setStatus,
} = require('./helpers');

const { toBytes32 } = require('../..');

contract('BaseDPassive', async accounts => {
	const [dUSD, dAUD, dEUR, DPS, dETH] = ['dUSD', 'dAUD', 'dEUR', 'DPS', 'dETH'].map(toBytes32);

	const [, owner, account1, account2, account3] = accounts;

	let baseDPassive,
		exchangeRates,
		debtCache,
		escrow,
		oracle,
		timestamp,
		addressResolver,
		systemSettings,
		systemStatus;

	before(async () => {
		({
			DPassive: baseDPassive,
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
			DebtCache: debtCache,
			SystemStatus: systemStatus,
			DPassiveEscrow: escrow,
		} = await setupAllContracts({
			accounts,
			synths: ['dUSD', 'dETH', 'dEUR', 'dAUD'],
			contracts: [
				'BaseDPassive',
				'DPassiveState',
				'SupplySchedule',
				'AddressResolver',
				'ExchangeRates',
				'SystemSettings',
				'SystemStatus',
				'DebtCache',
				'Issuer',
				'Exchanger',
				'RewardsDistribution',
				'CollateralManager',
				'RewardEscrowV2', // required for collateral check in issuer
			],
		}));

		// Send a price update to guarantee we're not stale.
		oracle = account1;
		timestamp = await currentTime();
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: baseDPassive.abi,
			ignoreParents: ['ExternStateToken', 'MixinResolver'],
			expected: [
				'burnSecondary',
				'burnSynths',
				'burnSynthsOnBehalf',
				'burnSynthsToTarget',
				'burnSynthsToTargetOnBehalf',
				'emitSynthExchange',
				'emitExchangeRebate',
				'emitExchangeReclaim',
				'emitExchangeTracking',
				'exchange',
				'exchangeOnBehalf',
				'exchangeOnBehalfWithTracking',
				'exchangeWithTracking',
				'exchangeWithTrackingForInitiator',
				'exchangeWithVirtual',
				'issueMaxSynths',
				'issueMaxSynthsOnBehalf',
				'issueSynths',
				'issueSynthsOnBehalf',
				'mint',
				'mintSecondary',
				'mintSecondaryRewards',
				'settle',
				'transfer',
				'transferFrom',
				'liquidateDelinquentAccount',
			],
		});
	});

	describe('constructor', () => {
		it('should set constructor params on deployment', async () => {
			const DPASSIVE_TOTAL_SUPPLY = web3.utils.toWei('100000000');
			const instance = await setupContract({
				contract: 'BaseDPassive',
				accounts,
				skipPostDeploy: true,
				args: [account1, account2, owner, DPASSIVE_TOTAL_SUPPLY, addressResolver.address],
			});

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), DPASSIVE_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});

		it('should set constructor params on upgrade to new totalSupply', async () => {
			const YEAR_2_DPASSIVE_TOTAL_SUPPLY = web3.utils.toWei('175000000');
			const instance = await setupContract({
				contract: 'BaseDPassive',
				accounts,
				skipPostDeploy: true,
				args: [account1, account2, owner, YEAR_2_DPASSIVE_TOTAL_SUPPLY, addressResolver.address],
			});

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), YEAR_2_DPASSIVE_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});
	});

	describe('non-basic functions always revert', () => {
		const amount = 100;
		it('exchangeWithVirtual should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.exchangeWithVirtual,
				accounts,
				args: [dUSD, amount, dAUD, toBytes32('AGGREGATOR')],
				reason: 'Cannot be run on this layer',
			});
		});

		it('exchangeWithTrackingForInitiator should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.exchangeWithTrackingForInitiator,
				accounts,
				args: [dUSD, amount, dAUD, owner, toBytes32('AGGREGATOR')],
				reason: 'Cannot be run on this layer',
			});
		});

		it('mint should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.mint,
				accounts,
				args: [],
				reason: 'Cannot be run on this layer',
			});
		});

		it('liquidateDelinquentAccount should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.liquidateDelinquentAccount,
				accounts,
				args: [account1, amount],
				reason: 'Cannot be run on this layer',
			});
		});
		it('mintSecondary should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.mintSecondary,
				accounts,
				args: [account1, amount],
				reason: 'Cannot be run on this layer',
			});
		});
		it('mintSecondaryRewards should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.mintSecondaryRewards,
				accounts,
				args: [amount],
				reason: 'Cannot be run on this layer',
			});
		});
		it('burnSecondary should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.burnSecondary,
				accounts,
				args: [account1, amount],
				reason: 'Cannot be run on this layer',
			});
		});
	});

	describe('only Exchanger can call emit event functions', () => {
		const amount1 = 10;
		const amount2 = 100;
		const currencyKey1 = dAUD;
		const currencyKey2 = dEUR;
		const trackingCode = toBytes32('1inch');

		it('emitExchangeTracking() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.emitExchangeTracking,
				accounts,
				args: [trackingCode, currencyKey1, amount1, amount2],
				reason: 'Only Exchanger can invoke this',
			});
		});
		it('emitExchangeRebate() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.emitExchangeRebate,
				accounts,
				args: [account1, currencyKey1, amount1],
				reason: 'Only Exchanger can invoke this',
			});
		});
		it('emitExchangeReclaim() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.emitExchangeReclaim,
				accounts,
				args: [account1, currencyKey1, amount1],
				reason: 'Only Exchanger can invoke this',
			});
		});
		it('emitSynthExchange() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseDPassive.emitSynthExchange,
				accounts,
				args: [account1, currencyKey1, amount1, currencyKey2, amount2, account2],
				reason: 'Only Exchanger can invoke this',
			});
		});

		describe('Exchanger calls emit', () => {
			const exchanger = account1;
			let tx1, tx2, tx3, tx4;
			beforeEach('pawn Exchanger and sync cache', async () => {
				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger], {
					from: owner,
				});
				await baseDPassive.rebuildCache();
			});
			beforeEach('call event emission functions', async () => {
				tx1 = await baseDPassive.emitExchangeRebate(account1, currencyKey1, amount1, {
					from: exchanger,
				});
				tx2 = await baseDPassive.emitExchangeReclaim(account1, currencyKey1, amount1, {
					from: exchanger,
				});
				tx3 = await baseDPassive.emitSynthExchange(
					account1,
					currencyKey1,
					amount1,
					currencyKey2,
					amount2,
					account2,
					{ from: exchanger }
				);
				tx4 = await baseDPassive.emitExchangeTracking(
					trackingCode,
					currencyKey1,
					amount1,
					amount2,
					{ from: exchanger }
				);
			});

			it('the corresponding events are emitted', async () => {
				it('the corresponding events are emitted', async () => {
					assert.eventEqual(tx1, 'ExchangeRebate', {
						account: account1,
						currencyKey: currencyKey1,
						amount: amount1,
					});
					assert.eventEqual(tx2, 'ExchangeReclaim', {
						account: account1,
						currencyKey: currencyKey1,
						amount: amount1,
					});
					assert.eventEqual(tx3, 'SynthExchange', {
						account: account1,
						fromCurrencyKey: currencyKey1,
						fromAmount: amount1,
						toCurrencyKey: currencyKey2,
						toAmount: amount2,
						toAddress: account2,
					});
					assert.eventEqual(tx4, 'ExchangeTracking', {
						trackingCode: trackingCode,
						toCurrencyKey: currencyKey1,
						toAmount: amount1,
						fee: amount2,
					});
				});
			});
		});
	});

	describe('Exchanger calls', () => {
		let smockExchanger;
		beforeEach(async () => {
			smockExchanger = await smockit(artifacts.require('Exchanger').abi);
			smockExchanger.smocked.exchangeOnBehalf.will.return.with(() => '1');
			smockExchanger.smocked.exchangeWithTracking.will.return.with(() => '1');
			smockExchanger.smocked.exchangeOnBehalfWithTracking.will.return.with(() => '1');
			smockExchanger.smocked.settle.will.return.with(() => ['1', '2', '3']);
			await addressResolver.importAddresses(
				['Exchanger'].map(toBytes32),
				[smockExchanger.address],
				{ from: owner }
			);
			await baseDPassive.rebuildCache();
		});

		const amount1 = '10';
		const currencyKey1 = dAUD;
		const currencyKey2 = dEUR;
		const msgSender = owner;
		const trackingCode = toBytes32('1inch');

		it('exchangeOnBehalf is called with the right arguments ', async () => {
			await baseDPassive.exchangeOnBehalf(account1, currencyKey1, amount1, currencyKey2, {
				from: msgSender,
			});
			assert.equal(smockExchanger.smocked.exchangeOnBehalf.calls[0][0], account1);
			assert.equal(smockExchanger.smocked.exchangeOnBehalf.calls[0][1], msgSender);
			assert.equal(smockExchanger.smocked.exchangeOnBehalf.calls[0][2], currencyKey1);
			assert.equal(smockExchanger.smocked.exchangeOnBehalf.calls[0][3].toString(), amount1);
			assert.equal(smockExchanger.smocked.exchangeOnBehalf.calls[0][4], currencyKey2);
		});

		it('exchangeWithTracking is called with the right arguments ', async () => {
			await baseDPassive.exchangeWithTracking(
				currencyKey1,
				amount1,
				currencyKey2,
				account2,
				trackingCode,
				{ from: msgSender }
			);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][0], msgSender);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][1], currencyKey1);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][2].toString(), amount1);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][3], currencyKey2);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][4], msgSender);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][5], account2);
			assert.equal(smockExchanger.smocked.exchangeWithTracking.calls[0][6], trackingCode);
		});

		it('exchangeOnBehalfWithTracking is called with the right arguments ', async () => {
			await baseDPassive.exchangeOnBehalfWithTracking(
				account1,
				currencyKey1,
				amount1,
				currencyKey2,
				account2,
				trackingCode,
				{ from: owner }
			);
			assert.equal(smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][0], account1);
			assert.equal(smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][1], msgSender);
			assert.equal(smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][2], currencyKey1);
			assert.equal(
				smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][3].toString(),
				amount1
			);
			assert.equal(smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][4], currencyKey2);
			assert.equal(smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][5], account2);
			assert.equal(smockExchanger.smocked.exchangeOnBehalfWithTracking.calls[0][6], trackingCode);
		});

		it('settle is called with the right arguments ', async () => {
			await baseDPassive.settle(currencyKey1, {
				from: owner,
			});
			assert.equal(smockExchanger.smocked.settle.calls[0][0], msgSender);
			assert.equal(smockExchanger.smocked.settle.calls[0][1].toString(), currencyKey1);
		});
	});

	describe('isWaitingPeriod()', () => {
		it('returns false by default', async () => {
			assert.isFalse(await baseDPassive.isWaitingPeriod(dETH));
		});
		describe('when a user has exchanged into dETH', () => {
			beforeEach(async () => {
				await updateRatesWithDefaults({ exchangeRates, oracle, debtCache });

				await baseDPassive.issueSynths(toUnit('100'), { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dETH, { from: owner });
			});
			it('then waiting period is true', async () => {
				assert.isTrue(await baseDPassive.isWaitingPeriod(dETH));
			});
			describe('when the waiting period expires', () => {
				beforeEach(async () => {
					await fastForward(await systemSettings.waitingPeriodSecs());
				});
				it('returns false by default', async () => {
					assert.isFalse(await baseDPassive.isWaitingPeriod(dETH));
				});
			});
		});
	});

	describe('anySynthOrDPSRateIsInvalid()', () => {
		it('should have stale rates initially', async () => {
			assert.equal(await baseDPassive.anySynthOrDPSRateIsInvalid(), true);
		});
		describe('when synth rates set', () => {
			beforeEach(async () => {
				// fast forward to get past initial DPS setting
				await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));

				timestamp = await currentTime();

				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH],
					['0.5', '1.25', '100'].map(toUnit),
					timestamp,
					{ from: oracle }
				);
				await debtCache.takeDebtSnapshot();
			});
			it('should still have stale rates', async () => {
				assert.equal(await baseDPassive.anySynthOrDPSRateIsInvalid(), true);
			});
			describe('when DPS is also set', () => {
				beforeEach(async () => {
					timestamp = await currentTime();

					await exchangeRates.updateRates([DPS], ['1'].map(toUnit), timestamp, { from: oracle });
				});
				it('then no stale rates', async () => {
					assert.equal(await baseDPassive.anySynthOrDPSRateIsInvalid(), false);
				});

				describe('when only some synths are updated', () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));

						timestamp = await currentTime();

						await exchangeRates.updateRates([DPS, dAUD], ['0.1', '0.78'].map(toUnit), timestamp, {
							from: oracle,
						});
					});

					it('then anySynthOrDPSRateIsInvalid() returns true', async () => {
						assert.equal(await baseDPassive.anySynthOrDPSRateIsInvalid(), true);
					});
				});
			});
		});
	});

	describe('availableCurrencyKeys()', () => {
		it('returns all currency keys by default', async () => {
			assert.deepEqual(await baseDPassive.availableCurrencyKeys(), [dUSD, dETH, dEUR, dAUD]);
		});
	});

	describe('isWaitingPeriod()', () => {
		it('returns false by default', async () => {
			assert.isFalse(await baseDPassive.isWaitingPeriod(dETH));
		});
	});

	describe('transfer()', () => {
		describe('when the system is suspended', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await baseDPassive.approve(account1, toUnit('10'), { from: owner });
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when transfer() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					baseDPassive.transfer(account1, toUnit('10'), { from: owner }),
					'Operation prohibited'
				);
			});
			it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					baseDPassive.transferFrom(owner, account2, toUnit('10'), { from: account1 }),
					'Operation prohibited'
				);
			});
			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when transfer() is invoked, it works as expected', async () => {
					await baseDPassive.transfer(account1, toUnit('10'), { from: owner });
				});
				it('when transferFrom() is invoked, it works as expected', async () => {
					await baseDPassive.transferFrom(owner, account2, toUnit('10'), { from: account1 });
				});
			});
		});

		beforeEach(async () => {
			// Ensure all synths have rates to allow issuance
			await updateRatesWithDefaults({ exchangeRates, oracle, debtCache });
		});

		it('should transfer using the ERC20 transfer function @gasprofile', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all DPS.

			assert.bnEqual(await baseDPassive.totalSupply(), await baseDPassive.balanceOf(owner));

			const transaction = await baseDPassive.transfer(account1, toUnit('10'), { from: owner });

			assert.eventEqual(transaction, 'Transfer', {
				from: owner,
				to: account1,
				value: toUnit('10'),
			});

			assert.bnEqual(await baseDPassive.balanceOf(account1), toUnit('10'));
		});

		it('should revert when exceeding locked dpassive and calling the ERC20 transfer function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all DPS.
			assert.bnEqual(await baseDPassive.totalSupply(), await baseDPassive.balanceOf(owner));

			// Issue max synths.
			await baseDPassive.issueMaxSynths({ from: owner });

			// Try to transfer 0.000000000000000001 DPS
			await assert.revert(
				baseDPassive.transfer(account1, '1', { from: owner }),
				'Cannot transfer staked or escrowed DPS'
			);
		});

		it('should transfer using the ERC20 transferFrom function @gasprofile', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all DPS.
			const previousOwnerBalance = await baseDPassive.balanceOf(owner);
			assert.bnEqual(await baseDPassive.totalSupply(), previousOwnerBalance);

			// Approve account1 to act on our behalf for 10 DPS.
			let transaction = await baseDPassive.approve(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Approval', {
				owner: owner,
				spender: account1,
				value: toUnit('10'),
			});

			// Assert that transferFrom works.
			transaction = await baseDPassive.transferFrom(owner, account2, toUnit('10'), {
				from: account1,
			});

			assert.eventEqual(transaction, 'Transfer', {
				from: owner,
				to: account2,
				value: toUnit('10'),
			});

			// Assert that account2 has 10 DPS and owner has 10 less DPS
			assert.bnEqual(await baseDPassive.balanceOf(account2), toUnit('10'));
			assert.bnEqual(await baseDPassive.balanceOf(owner), previousOwnerBalance.sub(toUnit('10')));

			// Assert that we can't transfer more even though there's a balance for owner.
			await assert.revert(
				baseDPassive.transferFrom(owner, account2, '1', {
					from: account1,
				})
			);
		});

		it('should revert when exceeding locked dpassive and calling the ERC20 transferFrom function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all DPS.
			assert.bnEqual(await baseDPassive.totalSupply(), await baseDPassive.balanceOf(owner));

			// Approve account1 to act on our behalf for 10 DPS.
			const transaction = await baseDPassive.approve(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Approval', {
				owner: owner,
				spender: account1,
				value: toUnit('10'),
			});

			// Issue max synths
			await baseDPassive.issueMaxSynths({ from: owner });

			// Assert that transferFrom fails even for the smallest amount of DPS.
			await assert.revert(
				baseDPassive.transferFrom(owner, account2, '1', {
					from: account1,
				}),
				'Cannot transfer staked or escrowed DPS'
			);
		});

		describe('when the user has issued some dUSD and exchanged for other synths', () => {
			beforeEach(async () => {
				await baseDPassive.issueSynths(toUnit('100'), { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dETH, { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dAUD, { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dEUR, { from: owner });
			});
			it('should transfer using the ERC20 transfer function @gasprofile', async () => {
				await baseDPassive.transfer(account1, toUnit('10'), { from: owner });

				assert.bnEqual(await baseDPassive.balanceOf(account1), toUnit('10'));
			});

			it('should transfer using the ERC20 transferFrom function @gasprofile', async () => {
				const previousOwnerBalance = await baseDPassive.balanceOf(owner);

				// Approve account1 to act on our behalf for 10 DPS.
				await baseDPassive.approve(account1, toUnit('10'), { from: owner });

				// Assert that transferFrom works.
				await baseDPassive.transferFrom(owner, account2, toUnit('10'), {
					from: account1,
				});

				// Assert that account2 has 10 DPS and owner has 10 less DPS
				assert.bnEqual(await baseDPassive.balanceOf(account2), toUnit('10'));
				assert.bnEqual(await baseDPassive.balanceOf(owner), previousOwnerBalance.sub(toUnit('10')));

				// Assert that we can't transfer more even though there's a balance for owner.
				await assert.revert(
					baseDPassive.transferFrom(owner, account2, '1', {
						from: account1,
					})
				);
			});
		});

		describe('rates stale for transfers', () => {
			const value = toUnit('300');
			const ensureTransferReverts = async () => {
				await assert.revert(
					baseDPassive.transfer(account2, value, { from: account1 }),
					'A synth or DPS rate is invalid'
				);
				await assert.revert(
					baseDPassive.transferFrom(account2, account1, value, {
						from: account3,
					}),
					'A synth or DPS rate is invalid'
				);
			};

			beforeEach(async () => {
				// Give some DPS to account1 & account2
				await baseDPassive.transfer(account1, toUnit('10000'), {
					from: owner,
				});
				await baseDPassive.transfer(account2, toUnit('10000'), {
					from: owner,
				});

				// Ensure that we can do a successful transfer before rates go stale
				await baseDPassive.transfer(account2, value, { from: account1 });

				// approve account3 to transferFrom account2
				await baseDPassive.approve(account3, toUnit('10000'), { from: account2 });
				await baseDPassive.transferFrom(account2, account1, value, {
					from: account3,
				});
			});

			describe('when the user has a debt position', () => {
				beforeEach(async () => {
					// ensure the accounts have a debt position
					await Promise.all([
						baseDPassive.issueSynths(toUnit('1'), { from: account1 }),
						baseDPassive.issueSynths(toUnit('1'), { from: account2 }),
					]);

					// Now jump forward in time so the rates are stale
					await fastForward((await exchangeRates.rateStalePeriod()) + 1);
				});
				it('should not allow transfer if the exchange rate for DPS is stale', async () => {
					await ensureTransferReverts();

					const timestamp = await currentTime();

					// now give some synth rates
					await exchangeRates.updateRates([dAUD, dEUR], ['0.5', '1.25'].map(toUnit), timestamp, {
						from: oracle,
					});
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// the remainder of the synths have prices
					await exchangeRates.updateRates([dETH], ['100'].map(toUnit), timestamp, {
						from: oracle,
					});
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// now give DPS rate
					await exchangeRates.updateRates([DPS], ['1'].map(toUnit), timestamp, {
						from: oracle,
					});

					// now DPS transfer should work
					await baseDPassive.transfer(account2, value, { from: account1 });
					await baseDPassive.transferFrom(account2, account1, value, {
						from: account3,
					});
				});

				it('should not allow transfer if the exchange rate for any synth is stale', async () => {
					await ensureTransferReverts();

					const timestamp = await currentTime();

					// now give DPS rate
					await exchangeRates.updateRates([DPS], ['1'].map(toUnit), timestamp, {
						from: oracle,
					});
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// now give some synth rates
					await exchangeRates.updateRates([dAUD, dEUR], ['0.5', '1.25'].map(toUnit), timestamp, {
						from: oracle,
					});
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// now give the remainder of synths rates
					await exchangeRates.updateRates([dETH], ['100'].map(toUnit), timestamp, {
						from: oracle,
					});
					await debtCache.takeDebtSnapshot();

					// now DPS transfer should work
					await baseDPassive.transfer(account2, value, { from: account1 });
					await baseDPassive.transferFrom(account2, account1, value, {
						from: account3,
					});
				});
			});

			describe('when the user has no debt', () => {
				it('should allow transfer if the exchange rate for DPS is stale', async () => {
					// DPS transfer should work
					await baseDPassive.transfer(account2, value, { from: account1 });
					await baseDPassive.transferFrom(account2, account1, value, {
						from: account3,
					});
				});

				it('should allow transfer if the exchange rate for any synth is stale', async () => {
					// now DPS transfer should work
					await baseDPassive.transfer(account2, value, { from: account1 });
					await baseDPassive.transferFrom(account2, account1, value, {
						from: account3,
					});
				});
			});
		});

		describe('when the user holds DPS', () => {
			beforeEach(async () => {
				await baseDPassive.transfer(account1, toUnit('1000'), {
					from: owner,
				});
			});

			describe('and has an escrow entry', () => {
				beforeEach(async () => {
					// Setup escrow
					const escrowedDPassives = toUnit('30000');
					await baseDPassive.transfer(escrow.address, escrowedDPassives, {
						from: owner,
					});
				});

				it('should allow transfer of dpassive by default', async () => {
					await baseDPassive.transfer(account2, toUnit('100'), { from: account1 });
				});

				describe('when the user has a debt position (i.e. has issued)', () => {
					beforeEach(async () => {
						await baseDPassive.issueSynths(toUnit('10'), { from: account1 });
					});

					it('should not allow transfer of dpassive in escrow', async () => {
						// Ensure the transfer fails as all the dpassive are in escrow
						await assert.revert(
							baseDPassive.transfer(account2, toUnit('990'), { from: account1 }),
							'Cannot transfer staked or escrowed DPS'
						);
					});
				});
			});
		});

		it('should not be possible to transfer locked dpassive', async () => {
			const issuedDPassives = web3.utils.toBN('200000');
			await baseDPassive.transfer(account1, toUnit(issuedDPassives), {
				from: owner,
			});

			// Issue
			const amountIssued = toUnit('2000');
			await baseDPassive.issueSynths(amountIssued, { from: account1 });

			await assert.revert(
				baseDPassive.transfer(account2, toUnit(issuedDPassives), {
					from: account1,
				}),
				'Cannot transfer staked or escrowed DPS'
			);
		});

		it("should lock newly received dpassive if the user's collaterisation is too high", async () => {
			// Set dEUR for purposes of this test
			const timestamp1 = await currentTime();
			await exchangeRates.updateRates([dEUR], [toUnit('0.75')], timestamp1, { from: oracle });
			await debtCache.takeDebtSnapshot();

			const issuedDPassives = web3.utils.toBN('200000');
			await baseDPassive.transfer(account1, toUnit(issuedDPassives), {
				from: owner,
			});
			await baseDPassive.transfer(account2, toUnit(issuedDPassives), {
				from: owner,
			});

			const maxIssuableSynths = await baseDPassive.maxIssuableSynths(account1);

			// Issue
			await baseDPassive.issueSynths(maxIssuableSynths, { from: account1 });

			// Exchange into dEUR
			await baseDPassive.exchange(dUSD, maxIssuableSynths, dEUR, { from: account1 });

			// Ensure that we can transfer in and out of the account successfully
			await baseDPassive.transfer(account1, toUnit('10000'), {
				from: account2,
			});
			await baseDPassive.transfer(account2, toUnit('10000'), {
				from: account1,
			});

			// Increase the value of dEUR relative to dpassive
			const timestamp2 = await currentTime();
			await exchangeRates.updateRates([dEUR], [toUnit('2.10')], timestamp2, { from: oracle });
			await debtCache.takeDebtSnapshot();

			// Ensure that the new dpassive account1 receives cannot be transferred out.
			await baseDPassive.transfer(account1, toUnit('10000'), {
				from: account2,
			});
			await assert.revert(baseDPassive.transfer(account2, toUnit('10000'), { from: account1 }));
		});

		it('should unlock dpassive when collaterisation ratio changes', async () => {
			// prevent circuit breaker from firing by upping the threshold to factor 5
			await systemSettings.setPriceDeviationThresholdFactor(toUnit('5'), { from: owner });

			// Set dAUD for purposes of this test
			const timestamp1 = await currentTime();
			const aud2usdrate = toUnit('2');

			await exchangeRates.updateRates([dAUD], [aud2usdrate], timestamp1, { from: oracle });
			await debtCache.takeDebtSnapshot();

			const issuedDPassives = web3.utils.toBN('200000');
			await baseDPassive.transfer(account1, toUnit(issuedDPassives), {
				from: owner,
			});

			// Issue
			const issuedSynths = await baseDPassive.maxIssuableSynths(account1);
			await baseDPassive.issueSynths(issuedSynths, { from: account1 });
			const remainingIssuable = (await baseDPassive.remainingIssuableSynths(account1))[0];

			assert.bnClose(remainingIssuable, '0');

			const transferable1 = await baseDPassive.transferableDPassive(account1);
			assert.bnEqual(transferable1, '0');

			// Exchange into dAUD
			await baseDPassive.exchange(dUSD, issuedSynths, dAUD, { from: account1 });

			// Increase the value of dAUD relative to dpassive
			const timestamp2 = await currentTime();
			const newAUDExchangeRate = toUnit('1');
			await exchangeRates.updateRates([dAUD], [newAUDExchangeRate], timestamp2, { from: oracle });
			await debtCache.takeDebtSnapshot();

			const transferable2 = await baseDPassive.transferableDPassive(account1);
			assert.equal(transferable2.gt(toUnit('1000')), true);
		});

		describe('when the user has issued some dUSD and exchanged for other synths', () => {
			beforeEach(async () => {
				await baseDPassive.issueSynths(toUnit('100'), { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dETH, { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dAUD, { from: owner });
				await baseDPassive.exchange(dUSD, toUnit('10'), dEUR, { from: owner });
			});
			it('should transfer using the ERC20 transfer function @gasprofile', async () => {
				await baseDPassive.transfer(account1, toUnit('10'), { from: owner });

				assert.bnEqual(await baseDPassive.balanceOf(account1), toUnit('10'));
			});

			it('should transfer using the ERC20 transferFrom function @gasprofile', async () => {
				const previousOwnerBalance = await baseDPassive.balanceOf(owner);

				// Approve account1 to act on our behalf for 10 DPS.
				await baseDPassive.approve(account1, toUnit('10'), { from: owner });

				// Assert that transferFrom works.
				await baseDPassive.transferFrom(owner, account2, toUnit('10'), {
					from: account1,
				});

				// Assert that account2 has 10 DPS and owner has 10 less DPS
				assert.bnEqual(await baseDPassive.balanceOf(account2), toUnit('10'));
				assert.bnEqual(await baseDPassive.balanceOf(owner), previousOwnerBalance.sub(toUnit('10')));

				// Assert that we can't transfer more even though there's a balance for owner.
				await assert.revert(
					baseDPassive.transferFrom(owner, account2, '1', {
						from: account1,
					})
				);
			});
		});
	});
});
