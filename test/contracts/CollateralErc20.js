'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const BN = require('bn.js');

const PublicEST8Decimals = artifacts.require('PublicEST8Decimals');

const { fastForward, toUnit, currentTime } = require('../utils')();

const { setupAllContracts, setupContract } = require('./setup');

const { ensureOnlyExpectedMutativeFunctions, setStatus } = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

let CollateralManager;
let CollateralManagerState;
let CollateralState;
let ProxyERC20;
let TokenState;

contract('CollateralErc20', async accounts => {
	const YEAR = 31536000;
	const INTERACTION_DELAY = 300;

	const dUSD = toBytes32('dUSD');
	const dETH = toBytes32('dETH');
	const dBTC = toBytes32('dBTC');

	const oneRenBTC = web3.utils.toBN('100000000');
	const twoRenBTC = web3.utils.toBN('200000000');
	const fiveRenBTC = web3.utils.toBN('500000000');

	const onedUSD = toUnit(1);
	const tendUSD = toUnit(10);
	const oneHundreddUSD = toUnit(100);
	const oneThousanddUSD = toUnit(1000);
	const fiveThousanddUSD = toUnit(5000);

	let tx;
	let loan;
	let id;
	let proxy, tokenState;

	const [deployerAccount, owner, oracle, , account1, account2] = accounts;

	let cerc20,
		state,
		managerState,
		feePool,
		exchangeRates,
		addressResolver,
		dUSDSynth,
		dBTCSynth,
		renBTC,
		systemStatus,
		synths,
		manager,
		issuer,
		debtCache,
		FEE_ADDRESS;

	const getid = tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issuedUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of synths to deposit.
		await dUSDSynth.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	const issuedBTCtoAccount = async (issueAmount, receiver) => {
		await dBTCSynth.issue(receiver, issueAmount, { from: owner });
	};

	const issueRenBTCtoAccount = async (issueAmount, receiver) => {
		await renBTC.transfer(receiver, issueAmount, { from: owner });
	};

	const updateRatesWithDefaults = async () => {
		const timestamp = await currentTime();

		await exchangeRates.updateRates([dETH], ['100'].map(toUnit), timestamp, {
			from: oracle,
		});

		const dBTC = toBytes32('dBTC');

		await exchangeRates.updateRates([dBTC], ['10000'].map(toUnit), timestamp, {
			from: oracle,
		});
	};

	const fastForwardAndUpdateRates = async seconds => {
		await fastForward(seconds);
		await updateRatesWithDefaults();
	};

	const deployCollateral = async ({
		state,
		owner,
		manager,
		resolver,
		collatKey,
		minColat,
		minSize,
		underCon,
		decimals,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralErc20',
			args: [state, owner, manager, resolver, collatKey, minColat, minSize, underCon, decimals],
		});
	};

	const setupMultiCollateral = async () => {
		synths = ['dUSD', 'dBTC'];
		({
			SystemStatus: systemStatus,
			ExchangeRates: exchangeRates,
			SynthdUSD: dUSDSynth,
			SynthdBTC: dBTCSynth,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'DPassive',
				'FeePool',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Issuer',
				'DebtCache',
				'Exchanger',
			],
		}));

		managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		const maxDebt = toUnit(10000000);

		manager = await CollateralManager.new(
			managerState.address,
			owner,
			addressResolver.address,
			maxDebt,
			0,
			0,
			{
				from: deployerAccount,
			}
		);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		state = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		// the owner is the associated contract, so we can simulate
		proxy = await ProxyERC20.new(owner, {
			from: deployerAccount,
		});
		tokenState = await TokenState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		renBTC = await PublicEST8Decimals.new(
			proxy.address,
			tokenState.address,
			'Some Token',
			'TOKEN',
			toUnit('1000'),
			owner,
			{
				from: deployerAccount,
			}
		);

		await tokenState.setAssociatedContract(owner, { from: owner });
		await tokenState.setBalanceOf(owner, toUnit('1000'), { from: owner });
		await tokenState.setAssociatedContract(renBTC.address, { from: owner });

		await proxy.setTarget(renBTC.address, { from: owner });

		cerc20 = await deployCollateral({
			state: state.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: dBTC,
			minColat: toUnit(1.5),
			minSize: toUnit(0.1),
			underCon: renBTC.address,
			decimals: 8,
		});

		await state.setAssociatedContract(cerc20.address, { from: owner });

		await addressResolver.importAddresses(
			[toBytes32('CollateralErc20'), toBytes32('CollateralManager')],
			[cerc20.address, manager.address],
			{
				from: owner,
			}
		);

		await feePool.rebuildCache();
		await manager.rebuildCache();
		await issuer.rebuildCache();
		await debtCache.rebuildCache();

		await manager.addCollaterals([cerc20.address], { from: owner });

		await cerc20.addSynths(
			['SynthdUSD', 'SynthdBTC'].map(toBytes32),
			['dUSD', 'dBTC'].map(toBytes32),
			{ from: owner }
		);

		await manager.addSynths(
			['SynthdUSD', 'SynthdBTC'].map(toBytes32),
			['dUSD', 'dBTC'].map(toBytes32),
			{ from: owner }
		);
		// rebuild the cache to add the synths we need.
		await manager.rebuildCache();

		// Issue ren and set allowance
		await issueRenBTCtoAccount(100 * 1e8, account1);
		await renBTC.approve(cerc20.address, 100 * 1e8, { from: account1 });
	};

	before(async () => {
		CollateralManager = artifacts.require(`CollateralManager`);
		CollateralManagerState = artifacts.require('CollateralManagerState');
		CollateralState = artifacts.require(`CollateralState`);
		ProxyERC20 = artifacts.require(`ProxyERC20`);
		TokenState = artifacts.require(`TokenState`);

		await setupMultiCollateral();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateRatesWithDefaults();

		await issuedUSDToAccount(toUnit(1000), owner);
		await issuedBTCtoAccount(toUnit(10), owner);

		await debtCache.takeDebtSnapshot();
	});

	it('should set constructor params on deployment', async () => {
		assert.equal(await cerc20.state(), state.address);
		assert.equal(await cerc20.owner(), owner);
		assert.equal(await cerc20.resolver(), addressResolver.address);
		assert.equal(await cerc20.collateralKey(), dBTC);
		assert.equal(await cerc20.synths(0), toBytes32('SynthdUSD'));
		assert.equal(await cerc20.synths(1), toBytes32('SynthdBTC'));
		assert.bnEqual(await cerc20.minCratio(), toUnit(1.5));
		assert.bnEqual(await cerc20.minCollateral(), toUnit(0.1));
		assert.equal(await cerc20.underlyingContract(), renBTC.address);
		assert.bnEqual(await cerc20.underlyingContractDecimals(), await renBTC.decimals());
	});

	it('should ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: cerc20.abi,
			ignoreParents: ['Owned', 'Pausable', 'MixinResolver', 'Proxy', 'Collateral'],
			expected: ['open', 'close', 'deposit', 'repay', 'withdraw', 'liquidate', 'draw'],
		});
	});

	it('should access its dependencies via the address resolver', async () => {
		assert.equal(await addressResolver.getAddress(toBytes32('SynthdUSD')), dUSDSynth.address);
		assert.equal(await addressResolver.getAddress(toBytes32('FeePool')), feePool.address);
		assert.equal(
			await addressResolver.getAddress(toBytes32('ExchangeRates')),
			exchangeRates.address
		);
	});

	// PUBLIC VIEW TESTS
	describe('cratio test', async () => {
		describe('dUSD loans', async () => {
			beforeEach(async () => {
				tx = await cerc20.open(oneRenBTC, fiveThousanddUSD, dUSD, {
					from: account1,
				});

				id = getid(tx);
				loan = await state.getLoan(account1, id);
			});

			it('when we issue at 200%, our c ratio is 200%', async () => {
				const ratio = await cerc20.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(2));
			});

			it('when the price falls by 25% our c ratio is 150%', async () => {
				await exchangeRates.updateRates([dBTC], ['7500'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await cerc20.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(1.5));
			});

			it('when the price increases by 100% our c ratio is 400%', async () => {
				await exchangeRates.updateRates([dBTC], ['20000'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await cerc20.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(4));
			});

			it('when the price fallsby 50% our cratio is 100%', async () => {
				await exchangeRates.updateRates([dBTC], ['5000'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await cerc20.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(1));
			});
		});
		describe('dBTC loans', async () => {
			beforeEach(async () => {
				tx = await cerc20.open(twoRenBTC, toUnit(1), dBTC, {
					from: account1,
				});

				id = getid(tx);
				loan = await state.getLoan(account1, id);
			});

			it('when we issue at 200%, our c ratio is 200%', async () => {
				const ratio = await cerc20.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(2));
			});

			it('price changes should not change the cratio', async () => {
				await exchangeRates.updateRates([dBTC], ['75'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await cerc20.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(2));
			});
		});
	});

	describe('max loan test', async () => {
		it('should convert correctly', async () => {
			// $150 worth of btc should allow 100 dUSD to be issued.
			const dUSDAmount = await cerc20.maxLoan(toUnit(0.015), dUSD);

			assert.bnClose(dUSDAmount, toUnit(100), 100);

			// $150 worth of btc should allow $100 (1) of dETH to be issued.
			const dETHAmount = await cerc20.maxLoan(toUnit(0.015), dETH);

			assert.bnEqual(dETHAmount, toUnit(1));
		});
	});

	describe('scaling collateral test', async () => {
		it('should scale up 1e8 to 1e18 correctly', async () => {
			// Scaling up 1 renBTC to 18 decimals works.
			const scaledCollateral = await cerc20.scaleUpCollateral(oneRenBTC);

			assert.bnEqual(scaledCollateral, toUnit(1));
		});

		it('should scaled up 1.23456789 correctly', async () => {
			// Scaling up 1.2345678 renBTC to 8 decimals works.
			const bal = 123456789;
			const scaledCollateral = await cerc20.scaleUpCollateral(bal);

			assert.bnEqual(scaledCollateral, toUnit('1.23456789'));
		});

		it('should scale down 1e18 to 1e8 correctly', async () => {
			// Scaling down 1.2345678 renBTC to 8 decimals works.
			const scaledCollateral = await cerc20.scaleDownCollateral(toUnit('1'));

			assert.bnEqual(scaledCollateral, oneRenBTC);
		});

		it('should scale down 1.23456789 correctly', async () => {
			// Scaling down 1 renBTC to 8 decimals works.
			const scaledCollateral = await cerc20.scaleDownCollateral(toUnit('1.23456789'));

			assert.bnEqual(scaledCollateral, 123456789);
		});

		it('if more than 8 decimals come back, it truncates and does not round', async () => {
			// If we round, we might run out of ren in the contract.
			const scaledCollateral = await cerc20.scaleDownCollateral(toUnit('1.23456789999999999'));

			assert.bnEqual(scaledCollateral, 123456789);
		});
	});

	describe('liquidation amount test', async () => {
		let amountToLiquidate;

		/**
		 * r = target issuance ratio
		 * D = debt balance in dUSD
		 * V = Collateral VALUE in dUSD
		 * P = liquidation penalty
		 * Calculates amount of dUSD = (D - V * r) / (1 - (1 + P) * r)
		 *
		 * To go back to another synth, remember to do effective value
		 */

		beforeEach(async () => {
			tx = await cerc20.open(oneRenBTC, fiveThousanddUSD, dUSD, {
				from: account1,
			});

			id = getid(tx);
			loan = await state.getLoan(account1, id);
		});

		it('when we start at 200%, we can take a 25% reduction in collateral prices', async () => {
			await exchangeRates.updateRates([dBTC], ['7500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnEqual(amountToLiquidate, toUnit(0));
		});

		it('when we start at 200%, a price shock of 30% in the collateral requires 25% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([dBTC], ['7000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(1250), '10000');
		});

		it('when we start at 200%, a price shock of 40% in the collateral requires 75% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([dBTC], ['6000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(3750), '10000');
		});

		it('when we start at 200%, a price shock of 45% in the collateral requires 100% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([dBTC], ['5500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(5000), '10000');
		});

		// it('when we start at 150%, a 25% reduction in collateral requires', async () => {
		// 	tx = await cerc20.open(oneRenBTC, fiveThousanddUSD, dUSD, {
		// 		from: account1,
		// 	});

		// 	id = getid(tx);

		// 	await exchangeRates.updateRates([dBTC], ['7500'].map(toUnit), await currentTime(), {
		// 		from: oracle,
		// 	});

		// 	loan = await state.getLoan(account1, id);

		// 	amountToLiquidate = await cerc20.liquidationAmount(loan);

		// 	assert.bnClose(amountToLiquidate, toUnit(4687.5), 10000);
		// });

		// it('when we start at 150%, any reduction in collateral will make the position undercollateralised ', async () => {
		// 	tx = await cerc20.open(750000000, fiveThousanddUSD, dUSD, {
		// 		from: account1,
		// 	});

		// 	id = getid(tx);
		// 	loan = await state.getLoan(account1, id);

		// 	await exchangeRates.updateRates([dBTC], ['9000'].map(toUnit), await currentTime(), {
		// 		from: oracle,
		// 	});

		// 	amountToLiquidate = await cerc20.liquidationAmount(loan);

		// 	assert.bnClose(amountToLiquidate, toUnit(1875), 10000);
		// });
	});

	describe('collateral redeemed test', async () => {
		let collateralRedeemed;

		it('when BTC is @ $10000 and we are liquidating 1000 dUSD, then redeem 0.11 BTC', async () => {
			collateralRedeemed = await cerc20.collateralRedeemed(dUSD, oneThousanddUSD);

			assert.bnEqual(collateralRedeemed, toUnit(0.11));
		});

		it('when BTC is @ $20000 and we are liquidating 1000 dUSD, then redeem 0.055 BTC', async () => {
			await exchangeRates.updateRates([dBTC], ['20000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await cerc20.collateralRedeemed(dUSD, oneThousanddUSD);

			assert.bnEqual(collateralRedeemed, toUnit(0.055));
		});

		it('when BTC is @ $7000 and we are liquidating 2500 dUSD, then redeem 0.36666 ETH', async () => {
			await exchangeRates.updateRates([dBTC], ['7000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await cerc20.collateralRedeemed(dUSD, toUnit(2500));

			assert.bnClose(collateralRedeemed, toUnit(0.392857142857142857), '100');
		});

		it('regardless of BTC price, we liquidate 1.1 * amount when doing dETH', async () => {
			collateralRedeemed = await cerc20.collateralRedeemed(dBTC, toUnit(1));

			assert.bnEqual(collateralRedeemed, toUnit(1.1));

			await exchangeRates.updateRates([dBTC], ['1000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await cerc20.collateralRedeemed(dBTC, toUnit(1));

			assert.bnEqual(collateralRedeemed, toUnit(1.1));
		});
	});

	// // SETTER TESTS

	describe('setting variables', async () => {
		describe('setMinCratio', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setMinCratio(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
				it('should fail if the minimum is less than 1', async () => {
					await assert.revert(
						cerc20.setMinCratio(toUnit(0.99), { from: owner }),
						'Must be greater than 1'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setMinCratio(toUnit(2), { from: owner });
				});
				it('should update the minCratio', async () => {
					assert.bnEqual(await cerc20.minCratio(), toUnit(2));
				});
			});
		});

		describe('setIssueFeeRate', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setIssueFeeRate(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setIssueFeeRate(toUnit(0.2), { from: owner });
				});
				it('should update the liquidation penalty', async () => {
					assert.bnEqual(await cerc20.issueFeeRate(), toUnit(0.2));
				});
				it('should allow the issue fee rate to be  0', async () => {
					await cerc20.setIssueFeeRate(toUnit(0), { from: owner });
					assert.bnEqual(await cerc20.issueFeeRate(), toUnit(0));
				});
			});
		});

		describe('setInteractionDelay', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setInteractionDelay(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
				it('should fail if the owner passes to big of a value', async () => {
					await assert.revert(
						cerc20.setInteractionDelay(toUnit(3601), { from: owner }),
						'Max 1 hour'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setInteractionDelay(toUnit(50), { from: owner });
				});
				it('should update the interaction delay', async () => {
					assert.bnEqual(await cerc20.interactionDelay(), toUnit(50));
				});
			});
		});

		describe('setManager', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setManager(ZERO_ADDRESS, { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setManager(ZERO_ADDRESS, { from: owner });
				});
				it('should update the manager', async () => {
					assert.bnEqual(await cerc20.manager(), ZERO_ADDRESS);
				});
			});
		});

		describe('setCanOpenLoans', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setCanOpenLoans(false, { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setCanOpenLoans(false, { from: owner });
				});
				it('should update the manager', async () => {
					assert.isFalse(await cerc20.canOpenLoans());
				});
			});
		});
	});

	// // LOAN INTERACTIONS

	describe('opening', async () => {
		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling openLoan() reverts', async () => {
						await assert.revert(
							cerc20.open(oneRenBTC, onedUSD, dUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling openLoan() succeeds', async () => {
							await cerc20.open(oneRenBTC, onedUSD, dUSD, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when rates have gone stale', () => {
				beforeEach(async () => {
					await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
				});
				it('then calling openLoan() reverts', async () => {
					await assert.revert(
						cerc20.open(oneRenBTC, onedUSD, dUSD, { from: account1 }),
						'Collateral rate is invalid'
					);
				});
				describe('when BTC gets a rate', () => {
					beforeEach(async () => {
						await updateRatesWithDefaults();
					});
					it('then calling openLoan() succeeds', async () => {
						await cerc20.open(oneRenBTC, onedUSD, dUSD, { from: account1 });
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they request a currency that is not supported', async () => {
				await assert.revert(
					cerc20.open(oneRenBTC, onedUSD, toBytes32('dJPY'), { from: account1 }),
					'Not allowed to issue this synth'
				);
			});

			it('should revert if they send 0 collateral', async () => {
				await assert.revert(
					cerc20.open(toUnit(0), onedUSD, dUSD, { from: account1 }),
					'Not enough collateral to open'
				);
			});

			it('should revert if the requested loan exceeds borrowing power', async () => {
				await assert.revert(
					cerc20.open(oneRenBTC, toUnit(10000), dUSD, {
						from: account1,
					}),
					'Exceeds max borrowing power'
				);
			});
		});

		describe('should open a btc loan denominated in dUSD', async () => {
			const fiveHundredDUSD = toUnit(500);
			let issueFeeRate;
			let issueFee;

			beforeEach(async () => {
				tx = await cerc20.open(oneRenBTC, fiveHundredDUSD, dUSD, {
					from: account1,
				});

				id = getid(tx);

				loan = await state.getLoan(account1, id);

				issueFeeRate = new BN(await cerc20.issueFeeRate());
				issueFee = fiveHundredDUSD.mul(issueFeeRate);
			});

			it('should set the loan correctly', async () => {
				assert.equal(loan.account, account1);
				assert.equal(loan.collateral, toUnit(1).toString());
				assert.equal(loan.currency, dUSD);
				assert.equal(loan.amount, fiveHundredDUSD.toString());
				assert.equal(loan.accruedInterest, toUnit(0));
			});

			it('should issue the correct amount to the borrower', async () => {
				const expectedBal = fiveHundredDUSD.sub(issueFee);

				assert.bnEqual(await dUSDSynth.balanceOf(account1), expectedBal);
			});

			it('should issue the minting fee to the fee pool', async () => {
				const feePoolBalance = await dUSDSynth.balanceOf(FEE_ADDRESS);

				assert.equal(issueFee, feePoolBalance.toString());
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanCreated', {
					account: account1,
					id: id,
					amount: fiveHundredDUSD,
					collateral: toUnit(1),
					currency: dUSD,
				});
			});
		});

		describe('should open a btc loan denominated in dBTC', async () => {
			let issueFeeRate;
			let issueFee;

			beforeEach(async () => {
				tx = await cerc20.open(fiveRenBTC, toUnit(2), dBTC, {
					from: account1,
				});

				id = getid(tx);

				loan = await state.getLoan(account1, id);

				issueFeeRate = await cerc20.issueFeeRate();
				issueFee = toUnit(2).mul(issueFeeRate);
			});

			it('should set the loan correctly', async () => {
				assert.equal(loan.account, account1);
				assert.equal(loan.collateral, toUnit(5).toString());
				assert.equal(loan.currency, dBTC);
				assert.equal(loan.amount, toUnit(2).toString());
				assert.equal(loan.accruedInterest, toUnit(0));
			});

			it('should issue the correct amount to the borrower', async () => {
				const expecetdBalance = toUnit(2).sub(issueFee);

				assert.bnEqual(await dBTCSynth.balanceOf(account1), expecetdBalance);
			});

			it('should issue the minting fee to the fee pool', async () => {
				const feePoolBalance = await dUSDSynth.balanceOf(FEE_ADDRESS);

				assert.equal(issueFee, feePoolBalance.toString());
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanCreated', {
					account: account1,
					id: id,
					amount: toUnit(2),
					collateral: toUnit(5),
					currency: dBTC,
				});
			});
		});
	});

	describe('deposits', async () => {
		beforeEach(async () => {
			tx = await cerc20.open(twoRenBTC, oneHundreddUSD, dUSD, {
				from: account1,
			});

			id = getid(tx);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling depopsit() reverts', async () => {
						await assert.revert(
							cerc20.deposit(account1, id, oneRenBTC, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling deposit() succeeds', async () => {
							await cerc20.deposit(account1, id, oneRenBTC, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they do not send any eth', async () => {
				await assert.revert(
					cerc20.deposit(account1, id, 0, { from: account1 }),
					'Deposit must be greater than 0'
				);
			});
		});

		describe('should allow deposits', async () => {
			beforeEach(async () => {
				await cerc20.deposit(account1, id, oneRenBTC, { from: account1 });
			});

			it('should increase the total collateral of the loan', async () => {
				loan = await state.getLoan(account1, id);

				assert.bnEqual(loan.collateral, toUnit(3));
			});
		});
	});

	describe('withdraws', async () => {
		let accountRenBalBefore;

		beforeEach(async () => {
			loan = await cerc20.open(twoRenBTC, oneHundreddUSD, dUSD, {
				from: account1,
			});

			id = getid(loan);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling depopsit() reverts', async () => {
						await assert.revert(
							cerc20.withdraw(id, oneRenBTC, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling deposit() succeeds', async () => {
							await cerc20.withdraw(id, oneRenBTC, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if the withdraw would put them under minimum collateralisation', async () => {
				await assert.revert(cerc20.withdraw(id, twoRenBTC, { from: account1 }), 'Cratio too low');
			});

			it('should revert if they try to withdraw all the collateral', async () => {
				await assert.revert(cerc20.withdraw(id, twoRenBTC, { from: account1 }), 'Cratio too low');
			});

			it('should revert if the sender is not borrower', async () => {
				await issuedBTCtoAccount(oneRenBTC, account2);
				await renBTC.approve(cerc20.address, oneRenBTC, { from: account2 });

				await assert.revert(cerc20.withdraw(id, oneRenBTC, { from: account2 }));
			});
		});

		describe('should allow withdraws', async () => {
			beforeEach(async () => {
				accountRenBalBefore = await renBTC.balanceOf(account1);

				await cerc20.withdraw(id, oneRenBTC, {
					from: account1,
				});
			});

			it('should decrease the total collateral of the loan', async () => {
				loan = await state.getLoan(account1, id);

				const expectedCollateral = toUnit(2).sub(toUnit(1));

				assert.bnEqual(loan.collateral, expectedCollateral);
			});

			it('should transfer the withdrawn collateral to the borrower', async () => {
				const bal = await renBTC.balanceOf(account1);

				assert.bnEqual(bal, accountRenBalBefore.add(oneRenBTC));
			});
		});
	});

	describe('repayments', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(twoRenBTC, oneHundreddUSD, dUSD, {
				from: account1,
			});

			// to get past fee reclamation and settlement owing.
			await fastForwardAndUpdateRates(INTERACTION_DELAY);

			id = getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling repay() reverts', async () => {
						await assert.revert(
							cerc20.repay(account1, id, onedUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling repay() succeeds', async () => {
							await cerc20.repay(account1, id, onedUSD, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they try to repay 0', async () => {
				await assert.revert(
					cerc20.repay(account1, id, 0, { from: account1 }),
					'Payment must be greater than 0'
				);
			});

			// account 2 had no dUSD
			it('should revert if they have no dUSD', async () => {
				await assert.revert(
					cerc20.repay(account1, id, tendUSD, { from: account2 }),
					'Not enough synth balance'
				);
			});

			it('should revert if they try to pay more than the amount owing', async () => {
				await issuedUSDToAccount(toUnit(1000), account1);
				await assert.revert(
					cerc20.repay(account1, id, toUnit(1000), { from: account1 }),
					'VM Exception while processing transaction: revert SafeMath: subtraction overflow'
				);
			});
		});

		describe('should allow repayments on an dUSD loan', async () => {
			// I'm not testing interest here, just that payment reduces the amounts.
			const expectedString = '90000';

			beforeEach(async () => {
				await issuedUSDToAccount(oneHundreddUSD, account2);
				tx = await cerc20.repay(account1, id, tendUSD, { from: account2 });
				loan = await state.getLoan(account1, id);
			});

			it('should work reduce the repayers balance', async () => {
				const expectedBalance = toUnit(90);
				assert.bnEqual(await dUSDSynth.balanceOf(account2), expectedBalance);
			});

			it('should update the loan', async () => {
				assert.bnClose(loan.amount.substring(0, 5), expectedString);
			});

			xit('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanRepaymentMade', {
					account: account1,
					repayer: account2,
					id: id,
					amountRepaid: tendUSD,
					amountAfter: parseInt(loan.amount),
				});
			});
		});

		describe('it should allow repayments on an dBTC loan', async () => {
			const expectedString = '10000';

			beforeEach(async () => {
				tx = await cerc20.open(fiveRenBTC, twoRenBTC, dBTC, {
					from: account1,
				});

				await fastForwardAndUpdateRates(INTERACTION_DELAY);

				id = getid(tx);

				await issuedBTCtoAccount(twoRenBTC, account2);

				tx = await cerc20.repay(account1, id, oneRenBTC, { from: account2 });

				loan = await state.getLoan(account1, id);
			});

			it('should work reduce the repayers balance', async () => {
				const expectedBalance = oneRenBTC;

				assert.bnEqual(await dBTCSynth.balanceOf(account2), expectedBalance);
			});

			it('should update the loan', async () => {
				assert.equal(loan.amount.substring(0, 5), expectedString);
			});

			xit('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanRepaymentMade', {
					account: account1,
					repayer: account2,
					id: id,
					amountRepaid: oneRenBTC,
				});
			});
		});
	});

	describe('liquidations', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(oneRenBTC, toUnit(5000), dUSD, {
				from: account1,
			});

			await fastForwardAndUpdateRates(INTERACTION_DELAY);

			id = getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling repay() reverts', async () => {
						await assert.revert(
							cerc20.liquidate(account1, id, onedUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling liquidate() succeeds', async () => {
							// fast forward a long time to make sure the loan is underwater.
							await fastForwardAndUpdateRates(10 * YEAR);
							await cerc20.liquidate(account1, id, onedUSD, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they have no dUSD', async () => {
				await assert.revert(
					cerc20.liquidate(account1, id, onedUSD, { from: account2 }),
					'Not enough synth balance'
				);
			});

			it('should revert if they are not under collateralised', async () => {
				await issuedUSDToAccount(toUnit(100), account2);

				await assert.revert(
					cerc20.liquidate(account1, id, onedUSD, { from: account2 }),
					'Cratio above liquidation ratio'
				);
			});
		});

		describe('should allow liquidations on an undercollateralised dUSD loan', async () => {
			const renAmount = new BN('19642857');
			const internalAmount = new BN('196428571428571428');
			let liquidationAmount;

			beforeEach(async () => {
				const timestamp = await currentTime();
				await exchangeRates.updateRates([dBTC], ['7000'].map(toUnit), timestamp, {
					from: oracle,
				});

				await issuedUSDToAccount(toUnit(5000), account2);

				loan = await state.getLoan(account1, id);

				liquidationAmount = await cerc20.liquidationAmount(loan);

				tx = await cerc20.liquidate(account1, id, liquidationAmount, {
					from: account2,
				});
			});

			it('should emit a liquidation event', async () => {
				assert.eventEqual(tx, 'LoanPartiallyLiquidated', {
					account: account1,
					id: id,
					liquidator: account2,
					amountLiquidated: liquidationAmount,
					collateralLiquidated: internalAmount,
				});
			});

			it('should reduce the liquidators synth amount', async () => {
				const liquidatorBalance = await dUSDSynth.balanceOf(account2);
				const expectedBalance = toUnit(5000).sub(liquidationAmount);

				assert.bnEqual(liquidatorBalance, expectedBalance);
			});

			it('should transfer the liquidated collateral to the liquidator', async () => {
				const bal = await renBTC.balanceOf(account2);

				assert.bnEqual(bal, renAmount);
			});

			it('should pay the interest to the fee pool', async () => {
				const balance = await dUSDSynth.balanceOf(FEE_ADDRESS);

				assert.bnGt(balance, toUnit(0));
			});

			it('should fix the collateralisation ratio of the loan', async () => {
				loan = await state.getLoan(account1, id);

				const ratio = await cerc20.collateralRatio(loan);

				// the loan is very close 150%, we are in 10^18 land.
				assert.bnClose(ratio, toUnit(1.5), '1000000000000');
			});
		});

		describe('when a loan needs to be completely liquidated', async () => {
			beforeEach(async () => {
				const timestamp = await currentTime();
				await exchangeRates.updateRates([dBTC], ['5000'].map(toUnit), timestamp, {
					from: oracle,
				});

				loan = await state.getLoan(account1, id);

				await issuedUSDToAccount(toUnit(10000), account2);

				tx = await cerc20.liquidate(account1, id, toUnit(10000), {
					from: account2,
				});
			});

			it('should emit the event', async () => {
				assert.eventEqual(tx, 'LoanClosedByLiquidation', {
					account: account1,
					id: id,
					liquidator: account2,
					amountLiquidated: loan.amount,
					collateralLiquidated: toUnit(1),
				});
			});

			it('should close the loan correctly', async () => {
				loan = await state.getLoan(account1, id);

				assert.equal(loan.amount, 0);
				assert.equal(loan.collateral, 0);
				assert.equal(loan.interestIndex, 0);
			});

			it('should transfer all the collateral to the liquidator', async () => {
				const bal = await renBTC.balanceOf(account2);

				assert.bnEqual(bal, oneRenBTC);
			});

			it('should reduce the liquidators synth balance', async () => {
				const liquidatorBalance = await dUSDSynth.balanceOf(account2);
				const expectedBalance = toUnit(10000).sub(toUnit(5000));

				assert.bnClose(liquidatorBalance, expectedBalance, '10000000000000000');
			});
		});
	});

	describe('closing', async () => {
		let accountRenBalBefore;

		beforeEach(async () => {
			accountRenBalBefore = await renBTC.balanceOf(account1);

			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(twoRenBTC, oneHundreddUSD, dUSD, {
				from: account1,
			});

			id = getid(tx);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling close() reverts', async () => {
						await assert.revert(cerc20.close(id, { from: account1 }), 'Operation prohibited');
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling close() succeeds', async () => {
							// Give them some more dUSD to make up for the fees.
							await issuedUSDToAccount(tendUSD, account1);
							await cerc20.close(id, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they have no dUSD', async () => {
				await assert.revert(cerc20.close(id, { from: account1 }), 'Not enough synth balance');
			});

			it('should revert if they are not the borrower', async () => {
				await assert.revert(cerc20.close(id, { from: account2 }), 'Loan does not exist');
			});
		});

		describe('when it works', async () => {
			beforeEach(async () => {
				// Give them some more dUSD to make up for the fees.
				await issuedUSDToAccount(tendUSD, account1);

				tx = await cerc20.close(id, { from: account1 });
			});

			it('should record the loan as closed', async () => {
				loan = await state.getLoan(account1, id);

				assert.equal(loan.amount, 0);
				assert.equal(loan.collateral, 0);
				assert.equal(loan.accruedInterest, 0);
				assert.equal(loan.interestIndex, 0);
			});

			it('should pay the fee pool', async () => {
				const balance = await dUSDSynth.balanceOf(FEE_ADDRESS);

				assert.bnGt(balance, toUnit(0));
			});

			it('should transfer the collateral back to the borrower', async () => {
				const bal = await renBTC.balanceOf(account1);
				assert.bnEqual(bal, accountRenBalBefore);
			});

			it('should emit the event', async () => {
				assert.eventEqual(tx, 'LoanClosed', {
					account: account1,
					id: id,
				});
			});
		});
	});

	describe('drawing', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(oneRenBTC, fiveThousanddUSD, dUSD, {
				from: account1,
			});

			id = getid(tx);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling draw() reverts', async () => {
						await assert.revert(
							cerc20.draw(id, onedUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling draw() succeeds', async () => {
							await cerc20.draw(id, onedUSD, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when rates have gone stale', () => {
				beforeEach(async () => {
					await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
				});
				it('then calling draw() reverts', async () => {
					await assert.revert(
						cerc20.draw(id, onedUSD, { from: account1 }),
						'Collateral rate is invalid'
					);
				});
				describe('when BTC gets a rate', () => {
					beforeEach(async () => {
						await updateRatesWithDefaults();
					});
					it('then calling draw() succeeds', async () => {
						await cerc20.draw(id, onedUSD, { from: account1 });
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if the draw would under collateralise the loan', async () => {
				await fastForwardAndUpdateRates(INTERACTION_DELAY);

				await assert.revert(
					cerc20.draw(id, toUnit(3000), { from: account1 }),
					'Cannot draw this much'
				);
			});
		});

		describe('should draw the loan down', async () => {
			beforeEach(async () => {
				tx = await cerc20.draw(id, oneThousanddUSD, { from: account1 });

				loan = await state.getLoan(account1, id);
			});

			it('should update the amount on the loan', async () => {
				assert.equal(loan.amount, toUnit(6000).toString());
			});
		});
	});
});
