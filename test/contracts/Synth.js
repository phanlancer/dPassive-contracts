'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const MockExchanger = artifacts.require('MockExchanger');
const Synth = artifacts.require('Synth');

const { setupAllContracts } = require('./setup');

const { currentTime, toUnit, bytesToString } = require('../utils')();
const {
	issueSynthsToUser,
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('Synth', async accounts => {
	const [dUSD, DPS, dEUR] = ['dUSD', 'DPS', 'dEUR'].map(toBytes32);

	const [deployerAccount, owner, oracle, , account1, account2] = accounts;

	let feePool,
		FEE_ADDRESS,
		dpassive,
		exchangeRates,
		dUSDContract,
		addressResolver,
		systemStatus,
		systemSettings,
		exchanger,
		debtCache,
		issuer;

	before(async () => {
		({
			AddressResolver: addressResolver,
			DPassive: dpassive,
			ExchangeRates: exchangeRates,
			FeePool: feePool,
			SystemStatus: systemStatus,
			Synth: dUSDContract,
			Exchanger: exchanger,
			DebtCache: debtCache,
			Issuer: issuer,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			contracts: [
				'Synth',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage', // required for Exchanger/FeePool to access the synth exchange fee rates
				'DPassive',
				'SystemStatus',
				'AddressResolver',
				'DebtCache',
				'Issuer', // required to issue via DPassive
				'Exchanger', // required to exchange into dUSD when transferring to the FeePool
				'SystemSettings',
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral() to read collateral
			],
		}));

		FEE_ADDRESS = await feePool.FEE_ADDRESS();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		const timestamp = await currentTime();

		// Send a price update to guarantee we're not stale.
		await exchangeRates.updateRates([DPS], ['0.1'].map(toUnit), timestamp, {
			from: oracle,
		});
		await debtCache.takeDebtSnapshot();

		// set default issuanceRatio to 0.2
		await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
	});

	it('should set constructor params on deployment', async () => {
		const synth = await Synth.new(
			account1,
			account2,
			'Synth XYZ',
			'dXYZ',
			owner,
			toBytes32('dXYZ'),
			web3.utils.toWei('100'),
			addressResolver.address,
			{ from: deployerAccount }
		);

		assert.equal(await synth.proxy(), account1);
		assert.equal(await synth.tokenState(), account2);
		assert.equal(await synth.name(), 'Synth XYZ');
		assert.equal(await synth.symbol(), 'dXYZ');
		assert.bnEqual(await synth.decimals(), 18);
		assert.equal(await synth.owner(), owner);
		assert.equal(bytesToString(await synth.currencyKey()), 'dXYZ');
		assert.bnEqual(await synth.totalSupply(), toUnit('100'));
		assert.equal(await synth.resolver(), addressResolver.address);
	});

	describe('mutative functions and access', () => {
		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: dUSDContract.abi,
				ignoreParents: ['ExternStateToken', 'MixinResolver'],
				expected: [
					'issue',
					'burn',
					'setTotalSupply',
					'transfer',
					'transferAndSettle',
					'transferFrom',
					'transferFromAndSettle',
				],
			});
		});

		describe('when non-internal contract tries to issue', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: dUSDContract.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
			});
		});
		describe('when non-internal tries to burn', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: dUSDContract.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only FeePool, Exchanger or Issuer contracts allowed',
				});
			});
		});
	});

	describe('suspension conditions on transfers', () => {
		const amount = toUnit('10000');
		beforeEach(async () => {
			// ensure owner has funds
			await dpassive.issueSynths(amount, { from: owner });

			// approve for transferFrom to work
			await dUSDContract.approve(account1, amount, { from: owner });
		});

		['System', 'Synth'].forEach(section => {
			describe(`when ${section} is suspended`, () => {
				const synth = toBytes32('dUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section, suspend: true, synth });
				});
				it('when transfer() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						dUSDContract.transfer(account1, amount, {
							from: owner,
						}),
						'Operation prohibited'
					);
				});
				it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						dUSDContract.transferFrom(owner, account1, amount, {
							from: account1,
						}),
						'Operation prohibited'
					);
				});
				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: false, synth });
					});
					it('when transfer() is invoked, it works as expected', async () => {
						await dUSDContract.transfer(account1, amount, {
							from: owner,
						});
					});
					it('when transferFrom() is invoked, it works as expected', async () => {
						await dUSDContract.transferFrom(owner, account1, amount, {
							from: account1,
						});
					});
				});
			});
		});
		describe('when dETH is suspended', () => {
			const synth = toBytes32('dETH');
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'Synth', synth, suspend: true });
			});
			it('when transfer() is invoked for dUSD, it works as expected', async () => {
				await dUSDContract.transfer(account1, amount, {
					from: owner,
				});
			});
			it('when transferFrom() is invoked for dUSD, it works as expected', async () => {
				await dUSDContract.transferFrom(owner, account1, amount, {
					from: account1,
				});
			});
			describe('when dUSD is suspended for exchanging', () => {
				const synth = toBytes32('dUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'SynthExchange', synth, suspend: true });
				});
				it('when transfer() is invoked for dUSD, it works as expected', async () => {
					await dUSDContract.transfer(account1, amount, {
						from: owner,
					});
				});
				it('when transferFrom() is invoked for dETH, it works as expected', async () => {
					await dUSDContract.transferFrom(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});
	});

	it('should transfer (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 dUSD.
		const amount = toUnit('10000');
		await dpassive.issueSynths(amount, { from: owner });

		// Do a single transfer of all our dUSD.
		const transaction = await dUSDContract.transfer(account1, amount, {
			from: owner,
		});

		// Events should be a fee exchange and a transfer to account1
		assert.eventEqual(
			transaction,
			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await dUSDContract.balanceOf(account1), amount);
	});

	it('should revert when transferring (ERC20) with insufficient balance', async () => {
		// Issue 10,000 dUSD.
		const amount = toUnit('10000');
		await dpassive.issueSynths(amount, { from: owner });

		// Try to transfer 10,000 + 1 wei, which we don't have the balance for.
		await assert.revert(
			dUSDContract.transfer(account1, amount.add(web3.utils.toBN('1')), { from: owner })
		);
	});

	it('should transferFrom (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 dUSD.
		const amount = toUnit('10000');
		await dpassive.issueSynths(amount, { from: owner });

		// Give account1 permission to act on our behalf
		await dUSDContract.approve(account1, amount, { from: owner });

		// Do a single transfer of all our dUSD.
		const transaction = await dUSDContract.transferFrom(owner, account1, amount, {
			from: account1,
		});

		// Events should be a transfer to account1
		assert.eventEqual(
			transaction,
			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await dUSDContract.balanceOf(account1), amount);

		// And allowance should be exhausted
		assert.bnEqual(await dUSDContract.allowance(owner, account1), 0);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient allowance', async () => {
		// Issue 10,000 dUSD.
		const amount = toUnit('10000');
		await dpassive.issueSynths(amount, { from: owner });

		// Approve for 1 wei less than amount
		await dUSDContract.approve(account1, amount.sub(web3.utils.toBN('1')), {
			from: owner,
		});

		// Try to transfer 10,000, which we don't have the allowance for.
		await assert.revert(
			dUSDContract.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient balance', async () => {
		// Issue 10,000 - 1 wei dUSD.
		const amount = toUnit('10000');
		await dpassive.issueSynths(amount.sub(web3.utils.toBN('1')), { from: owner });

		// Approve for full amount
		await dUSDContract.approve(account1, amount, { from: owner });

		// Try to transfer 10,000, which we don't have the balance for.
		await assert.revert(
			dUSDContract.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	describe('invoking issue/burn directly as Issuer', () => {
		beforeEach(async () => {
			// Overwrite DPassive address to the owner to allow us to invoke issue on the Synth
			await addressResolver.importAddresses(['Issuer'].map(toBytes32), [owner], { from: owner });
			// now have the synth resync its cache
			await dUSDContract.rebuildCache();
		});
		it('should issue successfully when called by Issuer', async () => {
			const transaction = await dUSDContract.issue(account1, toUnit('10000'), {
				from: owner,
			});
			assert.eventsEqual(
				transaction,
				'Transfer',
				{
					from: ZERO_ADDRESS,
					to: account1,
					value: toUnit('10000'),
				},
				'Issued',
				{
					account: account1,
					value: toUnit('10000'),
				}
			);
		});

		it('should burn successfully when called by Issuer', async () => {
			// Issue a bunch of synths so we can play with them.
			await dUSDContract.issue(owner, toUnit('10000'), {
				from: owner,
			});
			// await dpassive.issueSynths(toUnit('10000'), { from: owner });

			const transaction = await dUSDContract.burn(owner, toUnit('10000'), { from: owner });

			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: toUnit('10000') },
				'Burned',
				{ account: owner, value: toUnit('10000') }
			);
		});
	});

	it('should transfer (ERC20) with no fee', async () => {
		// Issue 10,000 dUSD.
		const amount = toUnit('10000');

		await dpassive.issueSynths(amount, { from: owner });

		// Do a single transfer of all our dUSD.
		const transaction = await dUSDContract.transfer(account1, amount, {
			from: owner,
		});

		// Event should be only a transfer to account1
		assert.eventEqual(
			transaction,

			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await dUSDContract.balanceOf(account1), amount);

		// The fee pool should have zero balance
		assert.bnEqual(await dUSDContract.balanceOf(FEE_ADDRESS), 0);
	});

	describe('transfer / transferFrom And Settle', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 1,000 dUSD.
			amount = toUnit('1000');

			await dpassive.issueSynths(amount, { from: owner });
		});

		describe('suspension conditions', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await dUSDContract.approve(account1, amount, { from: owner });
			});

			['System', 'Synth'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					const synth = toBytes32('dUSD');
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true, synth });
					});
					it('when transferAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							dUSDContract.transferAndSettle(account1, amount, {
								from: owner,
							}),
							'Operation prohibited'
						);
					});
					it('when transferFromAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							dUSDContract.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							}),
							'Operation prohibited'
						);
					});
					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false, synth });
						});
						it('when transferAndSettle() is invoked, it works as expected', async () => {
							await dUSDContract.transferAndSettle(account1, amount, {
								from: owner,
							});
						});
						it('when transferFromAndSettle() is invoked, it works as expected', async () => {
							await dUSDContract.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when dETH is suspended', () => {
				const synth = toBytes32('dETH');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'Synth', synth, suspend: true });
				});
				it('when transferAndSettle() is invoked for dUSD, it works as expected', async () => {
					await dUSDContract.transferAndSettle(account1, amount, {
						from: owner,
					});
				});
				it('when transferFromAndSettle() is invoked for dUSD, it works as expected', async () => {
					await dUSDContract.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});

		describe('with mock exchanger', () => {
			let exchanger;
			beforeEach(async () => {
				// Note: here we have a custom mock for Exchanger
				// this could use GenericMock if we added the ability for generic functions
				// to emit events and listened to those instead (so here, for Exchanger.settle() we'd
				// need to be sure it was invoked during transferAndSettle())
				exchanger = await MockExchanger.new(dpassive.address);

				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
					from: owner,
				});
				// now have dpassive resync its cache
				await dpassive.rebuildCache();
				await dUSDContract.rebuildCache();
			});
			it('then transferableSynths should be the total amount', async () => {
				assert.bnEqual(await dUSDContract.transferableSynths(owner), toUnit('1000'));
			});

			describe('when max seconds in waiting period is non-zero', () => {
				beforeEach(async () => {
					await exchanger.setMaxSecsLeft('1');
				});
				it('when the synth is attempted to be transferred away by the user, it reverts', async () => {
					await assert.revert(
						dUSDContract.transfer(account1, toUnit('1'), { from: owner }),
						'Cannot transfer during waiting period'
					);
				});
				it('when dEUR is attempted to be transferFrom away by another user, it reverts', async () => {
					await assert.revert(
						dUSDContract.transferFrom(owner, account2, toUnit('1'), { from: account1 }),
						'Cannot transfer during waiting period'
					);
				});
			});

			describe('when reclaim amount is set to 10', async () => {
				const reclaimAmount = toUnit('10');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
				});
				it('then transferableSynths should be the total amount minus the reclaim', async () => {
					assert.bnEqual(await dUSDContract.transferableSynths(owner), toUnit('990'));
				});
				it('should transfer all and settle 1000 dUSD less reclaim amount', async () => {
					// Do a single transfer of all our dUSD.
					await dUSDContract.transferAndSettle(account1, amount, {
						from: owner,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await dUSDContract.balanceOf(account1), expectedAmountTransferred);
				});
				it('should transferFrom all and settle 1000 dUSD less reclaim amount', async () => {
					// Give account1 permission to act on our behalf
					await dUSDContract.approve(account1, amount, { from: owner });

					// Do a single transfer of all our dUSD.
					await dUSDContract.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await dUSDContract.balanceOf(account1), expectedAmountTransferred);
				});
				describe('when account has more balance than transfer amount + reclaim', async () => {
					it('should transfer 50 dUSD and burn 10 dUSD', async () => {
						const transferAmount = toUnit('50');
						// Do a single transfer of all our dUSD.
						await dUSDContract.transferAndSettle(account1, transferAmount, {
							from: owner,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await dUSDContract.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await dUSDContract.balanceOf(account1), expectedAmountTransferred);
					});
					it('should transferFrom 50 dUSD and settle reclaim amount', async () => {
						const transferAmount = toUnit('50');

						// Give account1 permission to act on our behalf
						await dUSDContract.approve(account1, transferAmount, { from: owner });

						// Do a single transferFrom of transferAmount.
						await dUSDContract.transferFromAndSettle(owner, account1, transferAmount, {
							from: account1,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await dUSDContract.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await dUSDContract.balanceOf(account1), expectedAmountTransferred);
					});
				});
			});
			describe('when synth balance after reclamation is less than requested transfer value', async () => {
				let balanceBefore;
				const reclaimAmount = toUnit('600');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
					balanceBefore = await dUSDContract.balanceOf(owner);
				});
				describe('when reclaim 600 dUSD and attempting to transfer 500 dUSD synths', async () => {
					// original balance is 1000, reclaim 600 and should send 400
					const transferAmount = toUnit('500');

					describe('using regular transfer and transferFrom', () => {
						it('via regular transfer it reverts', async () => {
							await assert.revert(
								dUSDContract.transfer(account1, transferAmount, {
									from: owner,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
						it('via transferFrom it also reverts', async () => {
							await dUSDContract.approve(account1, transferAmount, { from: owner });
							await assert.revert(
								dUSDContract.transferFrom(owner, account1, transferAmount, {
									from: account1,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
					});
					describe('using transferAndSettle', () => {
						it('then transferableSynths should be the total amount', async () => {
							assert.bnEqual(await dUSDContract.transferableSynths(owner), toUnit('400'));
						});

						it('should transfer remaining balance less reclaimed', async () => {
							// Do a single transfer of all our dUSD.
							await dUSDContract.transferAndSettle(account1, transferAmount, {
								from: owner,
							});

							// should transfer balanceAfter if less than value
							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await dUSDContract.balanceOf(account1), balanceAfterReclaim);
						});
						it('should transferFrom and send balance minus reclaimed amount', async () => {
							// Give account1 permission to act on our behalf
							await dUSDContract.approve(account1, transferAmount, { from: owner });

							// Do a single transferFrom of transferAmount.
							await dUSDContract.transferFromAndSettle(owner, account1, transferAmount, {
								from: account1,
							});

							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await dUSDContract.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await dUSDContract.balanceOf(account1), balanceAfterReclaim);
						});
					});
				});
			});
		});
	});
	describe('when transferring synths to FEE_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 dUSD.
			amount = toUnit('10000');

			await dpassive.issueSynths(amount, { from: owner });
		});
		it('should transfer to FEE_ADDRESS and recorded as fee', async () => {
			const feeBalanceBefore = await dUSDContract.balanceOf(FEE_ADDRESS);

			// Do a single transfer of all our dUSD.
			const transaction = await dUSDContract.transfer(FEE_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to FEE_ADDRESS
			assert.eventEqual(
				transaction,

				// The original synth transfer
				'Transfer',
				{ from: owner, to: FEE_ADDRESS, value: amount }
			);

			const firstFeePeriod = await feePool.recentFeePeriods(0);
			// FEE_ADDRESS balance of dUSD increased
			assert.bnEqual(await dUSDContract.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amount));

			// fees equal to amount are recorded in feesToDistribute
			assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amount));
		});

		describe('when a non-USD synth exists', () => {
			let dEURContract;

			beforeEach(async () => {
				const dEUR = toBytes32('dEUR');

				// create a new dEUR synth
				({ Synth: dEURContract } = await setupAllContracts({
					accounts,
					existing: {
						ExchangeRates: exchangeRates,
						AddressResolver: addressResolver,
						SystemStatus: systemStatus,
						Issuer: issuer,
						DebtCache: debtCache,
						Exchanger: exchanger,
						FeePool: feePool,
						DPassive: dpassive,
					},
					contracts: [{ contract: 'Synth', properties: { currencyKey: dEUR } }],
				}));

				const timestamp = await currentTime();

				// Send a price update to guarantee we're not stale.
				await exchangeRates.updateRates([dEUR], ['1'].map(toUnit), timestamp, {
					from: oracle,
				});
				await debtCache.takeDebtSnapshot();
			});

			it('when transferring it to FEE_ADDRESS it should exchange into dUSD first before sending', async () => {
				// allocate the user some dEUR
				await issueSynthsToUser({
					owner,
					issuer,
					addressResolver,
					synthContract: dEURContract,
					user: owner,
					amount,
					synth: dEUR,
				});

				// Get balanceOf FEE_ADDRESS
				const feeBalanceBefore = await dUSDContract.balanceOf(FEE_ADDRESS);

				// balance of dEUR after exchange fees
				const balanceOf = await dEURContract.balanceOf(owner);

				const amountInUSD = await exchangeRates.effectiveValue(dEUR, balanceOf, dUSD);

				// Do a single transfer of all dEUR to FEE_ADDRESS
				await dEURContract.transfer(FEE_ADDRESS, balanceOf, {
					from: owner,
				});

				const firstFeePeriod = await feePool.recentFeePeriods(0);

				// FEE_ADDRESS balance of dUSD increased by USD amount given from exchange
				assert.bnEqual(
					await dUSDContract.balanceOf(FEE_ADDRESS),
					feeBalanceBefore.add(amountInUSD)
				);

				// fees equal to amountInUSD are recorded in feesToDistribute
				assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amountInUSD));
			});
		});
	});

	describe('when transferring synths to ZERO_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 dUSD.
			amount = toUnit('1000');

			await dpassive.issueSynths(amount, { from: owner });
		});
		it('should burn the synths and reduce totalSupply', async () => {
			const balanceBefore = await dUSDContract.balanceOf(owner);
			const totalSupplyBefore = await dUSDContract.totalSupply();

			// Do a single transfer of all our dUSD to ZERO_ADDRESS.
			const transaction = await dUSDContract.transfer(ZERO_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to ZERO_ADDRESS and burn
			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: amount },
				'Burned',
				{ account: owner, value: amount }
			);

			// owner balance should be less amount burned
			assert.bnEqual(await dUSDContract.balanceOf(owner), balanceBefore.sub(amount));

			// total supply of synth reduced by amount
			assert.bnEqual(await dUSDContract.totalSupply(), totalSupplyBefore.sub(amount));
		});
	});
});
