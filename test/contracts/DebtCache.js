'use strict';

const { contract, artifacts } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, setupContract, mockToken } = require('./setup');

const { currentTime, toUnit, fastForward, multiplyDecimalRound } = require('../utils')();

const {
	setExchangeFeeRateForSynths,
	getDecodedLogs,
	decodedEventEqual,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	defaults: { DEBT_SNAPSHOT_STALE_TIME },
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('DebtCache', async accounts => {
	const [dUSD, dAUD, dEUR, DPS, dETH, ETH, iETH] = [
		'dUSD',
		'dAUD',
		'dEUR',
		'DPS',
		'dETH',
		'ETH',
		'iETH',
	].map(toBytes32);
	const synthKeys = [dUSD, dAUD, dEUR, dETH, DPS];

	const [deployerAccount, owner, oracle, account1, account2] = accounts;

	const oneETH = toUnit('1.0');
	const twoETH = toUnit('2.0');

	let dpassive,
		systemStatus,
		systemSettings,
		exchangeRates,
		feePool,
		dUSDContract,
		dETHContract,
		dEURContract,
		dAUDContract,
		timestamp,
		debtCache,
		issuer,
		synths,
		addressResolver,
		exchanger,
		// EtherCollateral tests.
		etherCollateral,
		etherCollateraldUSD,
		// MultiCollateral tests.
		ceth,
		// Short tests.
		short;

	const deployCollateral = async ({
		state,
		owner,
		manager,
		resolver,
		collatKey,
		minColat,
		minSize,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralEth',
			args: [state, owner, manager, resolver, collatKey, minColat, minSize],
		});
	};

	const setupMultiCollateral = async () => {
		const CollateralManager = artifacts.require(`CollateralManager`);
		const CollateralState = artifacts.require(`CollateralState`);
		const CollateralManagerState = artifacts.require('CollateralManagerState');

		synths = ['dUSD', 'dETH', 'dAUD'];

		// Deploy CollateralManagerState.
		const managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, {
			from: deployerAccount,
		});

		const maxDebt = toUnit(10000000);

		// Deploy CollateralManager.
		const manager = await CollateralManager.new(
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

		const cethState = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		// Deploy ETH Collateral.
		ceth = await deployCollateral({
			state: cethState.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: dETH,
			minColat: toUnit('1.3'),
			minSize: toUnit('2'),
		});

		await cethState.setAssociatedContract(ceth.address, { from: owner });

		await addressResolver.importAddresses(
			[toBytes32('CollateralEth'), toBytes32('CollateralManager')],
			[ceth.address, manager.address],
			{
				from: owner,
			}
		);

		await ceth.rebuildCache();
		await manager.rebuildCache();
		await debtCache.rebuildCache();
		await feePool.rebuildCache();
		await issuer.rebuildCache();

		await manager.addCollaterals([ceth.address], { from: owner });

		await ceth.addSynths(
			['SynthdUSD', 'SynthdETH'].map(toBytes32),
			['dUSD', 'dETH'].map(toBytes32),
			{ from: owner }
		);

		await manager.addSynths(
			['SynthdUSD', 'SynthdETH'].map(toBytes32),
			['dUSD', 'dETH'].map(toBytes32),
			{ from: owner }
		);
		// rebuild the cache to add the synths we need.
		await manager.rebuildCache();

		// Set fees to 0.
		await ceth.setIssueFeeRate(toUnit('0'), { from: owner });
		await systemSettings.setExchangeFeeRateForSynths(
			synths.map(toBytes32),
			synths.map(s => toUnit('0')),
			{ from: owner }
		);
	};

	const deployShort = async ({ state, owner, manager, resolver, collatKey, minColat, minSize }) => {
		return setupContract({
			accounts,
			contract: 'CollateralShort',
			args: [state, owner, manager, resolver, collatKey, minColat, minSize],
		});
	};

	const setupShort = async () => {
		const CollateralManager = artifacts.require(`CollateralManager`);
		const CollateralState = artifacts.require(`CollateralState`);
		const CollateralManagerState = artifacts.require('CollateralManagerState');

		const managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, {
			from: deployerAccount,
		});

		const maxDebt = toUnit(10000000);

		const manager = await CollateralManager.new(
			managerState.address,
			owner,
			addressResolver.address,
			maxDebt,
			// 5% / 31536000 (seconds in common year)
			1585489599,
			0,
			{
				from: deployerAccount,
			}
		);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		const state = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		short = await deployShort({
			state: state.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: dUSD,
			minColat: toUnit(1.2),
			minSize: toUnit(0.1),
		});

		await state.setAssociatedContract(short.address, { from: owner });

		await addressResolver.importAddresses(
			[toBytes32('CollateralShort'), toBytes32('CollateralManager')],
			[short.address, manager.address],
			{
				from: owner,
			}
		);

		await feePool.rebuildCache();
		await manager.rebuildCache();
		await issuer.rebuildCache();
		await debtCache.rebuildCache();

		await manager.addCollaterals([short.address], { from: owner });

		await short.addSynths(['SynthdETH'].map(toBytes32), ['dETH'].map(toBytes32), { from: owner });

		await manager.addShortableSynths(
			[[toBytes32('SynthdETH'), toBytes32('SynthiETH')]],
			['dETH'].map(toBytes32),
			{
				from: owner,
			}
		);

		await dUSDContract.approve(short.address, toUnit(100000), { from: account1 });
	};

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {
		synths = ['dUSD', 'dAUD', 'dEUR', 'dETH', 'iETH'];
		({
			DPassive: dpassive,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			ExchangeRates: exchangeRates,
			SynthdUSD: dUSDContract,
			SynthdETH: dETHContract,
			SynthdAUD: dAUDContract,
			SynthdEUR: dEURContract,
			FeePool: feePool,
			DebtCache: debtCache,
			Issuer: issuer,
			AddressResolver: addressResolver,
			Exchanger: exchanger,
			EtherCollateral: etherCollateral,
			EtherCollateraldUSD: etherCollateraldUSD,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'DPassive',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'AddressResolver',
				'RewardEscrow',
				'DPassiveEscrow',
				'SystemSettings',
				'Issuer',
				'DebtCache',
				'Exchanger', // necessary for burnSynths to check settlement of dUSD
				'DelegateApprovals', // necessary for *OnBehalf functions
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // necessary for issuer._collateral()
				'EtherCollateral',
				'EtherCollateraldUSD',
			],
		}));
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		timestamp = await currentTime();

		await exchangeRates.updateRates(
			[dAUD, dEUR, DPS, dETH, ETH, iETH],
			['0.5', '1.25', '0.1', '200', '200', '200'].map(toUnit),
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
			abi: debtCache.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'takeDebtSnapshot',
				'purgeCachedSynthDebt',
				'updateCachedSynthDebts',
				'updateCachedSynthDebtWithRate',
				'updateCachedSynthDebtsWithRates',
				'updateDebtCacheValidity',
			],
		});
	});

	it('debt snapshot stale time is correctly configured as a default', async () => {
		assert.bnEqual(await debtCache.debtSnapshotStaleTime(), DEBT_SNAPSHOT_STALE_TIME);
	});

	describe('protected methods', () => {
		it('updateCachedSynthDebtWithRate() can only be invoked by the issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateCachedSynthDebtWithRate,
				args: [dAUD, toUnit('1')],
				accounts,
				reason: 'Sender is not Issuer',
			});
		});

		it('updateCachedSynthDebtsWithRates() can only be invoked by the issuer or exchanger', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateCachedSynthDebtsWithRates,
				args: [
					[dAUD, dEUR],
					[toUnit('1'), toUnit('2')],
				],
				accounts,
				reason: 'Sender is not Issuer or Exchanger',
			});
		});

		it('updateDebtCacheValidity() can only be invoked by the issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateDebtCacheValidity,
				args: [true],
				accounts,
				reason: 'Sender is not Issuer',
			});
		});

		it('purgeCachedSynthDebt() can only be invoked by the owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.purgeCachedSynthDebt,
				accounts,
				args: [dAUD],
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});
	});

	describe('After issuing synths', () => {
		beforeEach(async () => {
			// set minimumStakeTime on issue and burning to 0
			await systemSettings.setMinimumStakeTime(0, { from: owner });
			// set default issuance ratio of 0.2
			await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
			// set up initial prices
			await exchangeRates.updateRates(
				[dAUD, dEUR, dETH],
				['0.5', '2', '100'].map(toUnit),
				await currentTime(),
				{ from: oracle }
			);
			await debtCache.takeDebtSnapshot();

			// Issue 1000 dUSD worth of tokens to a user
			await dUSDContract.issue(account1, toUnit(100));
			await dAUDContract.issue(account1, toUnit(100));
			await dEURContract.issue(account1, toUnit(100));
			await dETHContract.issue(account1, toUnit(2));
		});

		describe('Current issued debt', () => {
			it('Live debt is reported accurately', async () => {
				// The synth debt has not yet been cached.
				assert.bnEqual((await debtCache.cacheInfo()).debt, toUnit(0));

				const result = await debtCache.currentDebt();
				assert.bnEqual(result[0], toUnit(550));
				assert.isFalse(result[1]);
			});

			it('Live debt is reported accurately for individual currencies', async () => {
				const result = await debtCache.currentSynthDebts([dUSD, dEUR, dAUD, dETH]);
				const debts = result[0];

				assert.bnEqual(debts[0], toUnit(100));
				assert.bnEqual(debts[1], toUnit(200));
				assert.bnEqual(debts[2], toUnit(50));
				assert.bnEqual(debts[3], toUnit(200));

				assert.isFalse(result[2]);
			});
		});

		describe('takeDebtSnapshot()', () => {
			let preTimestamp;
			let tx;
			let time;

			beforeEach(async () => {
				preTimestamp = (await debtCache.cacheInfo()).timestamp;
				await fastForward(5);
				tx = await debtCache.takeDebtSnapshot();
				time = await currentTime();
			});

			it('accurately resynchronises the debt after prices have changed', async () => {
				assert.bnEqual((await debtCache.cacheInfo()).debt, toUnit(550));
				let result = await debtCache.currentDebt();
				assert.bnEqual(result[0], toUnit(550));
				assert.isFalse(result[1]);

				await exchangeRates.updateRates([dAUD, dEUR], ['1', '3'].map(toUnit), await currentTime(), {
					from: oracle,
				});
				await debtCache.takeDebtSnapshot();
				assert.bnEqual((await debtCache.cacheInfo()).debt, toUnit(700));
				result = await debtCache.currentDebt();
				assert.bnEqual(result[0], toUnit(700));
				assert.isFalse(result[1]);
			});

			it('updates the debt snapshot timestamp', async () => {
				const timestamp = (await debtCache.cacheInfo()).timestamp;
				assert.bnNotEqual(timestamp, preTimestamp);
				assert.isTrue(time - timestamp < 15);
			});

			it('properly emits debt cache updated and synchronised events', async () => {
				assert.eventEqual(tx.logs[0], 'DebtCacheUpdated', [toUnit(550)]);
				assert.eventEqual(tx.logs[1], 'DebtCacheSnapshotTaken', [
					(await debtCache.cacheInfo()).timestamp,
				]);
			});

			it('updates the cached values for all individual synths', async () => {
				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH],
					['1', '3', '200'].map(toUnit),
					await currentTime(),
					{
						from: oracle,
					}
				);
				await debtCache.takeDebtSnapshot();
				let debts = await debtCache.currentSynthDebts([dUSD, dEUR, dAUD, dETH]);
				assert.bnEqual(debts[0][0], toUnit(100));
				assert.bnEqual(debts[0][1], toUnit(300));
				assert.bnEqual(debts[0][2], toUnit(100));
				assert.bnEqual(debts[0][3], toUnit(400));

				debts = await debtCache.cachedSynthDebts([dUSD, dEUR, dAUD, dETH]);
				assert.bnEqual(debts[0], toUnit(100));
				assert.bnEqual(debts[1], toUnit(300));
				assert.bnEqual(debts[2], toUnit(100));
				assert.bnEqual(debts[3], toUnit(400));
			});

			it('is able to invalidate and revalidate the debt cache when required.', async () => {
				// Wait until the exchange rates are stale in order to invalidate the cache.
				const rateStalePeriod = await systemSettings.rateStalePeriod();
				await fastForward(rateStalePeriod + 1000);

				assert.isFalse((await debtCache.cacheInfo()).isInvalid);

				// stale rates invalidate the cache
				const tx1 = await debtCache.takeDebtSnapshot();
				assert.isTrue((await debtCache.cacheInfo()).isInvalid);

				// Revalidate the cache once rates are no longer stale
				await exchangeRates.updateRates(
					[dAUD, dEUR, DPS, dETH, ETH, iETH],
					['0.5', '2', '100', '200', '200', '200'].map(toUnit),
					await currentTime(),
					{ from: oracle }
				);
				const tx2 = await debtCache.takeDebtSnapshot();
				assert.isFalse((await debtCache.cacheInfo()).isInvalid);

				assert.eventEqual(tx1.logs[2], 'DebtCacheValidityChanged', [true]);
				assert.eventEqual(tx2.logs[2], 'DebtCacheValidityChanged', [false]);
			});

			it('Rates are reported as invalid when snapshot is stale.', async () => {
				assert.isFalse((await debtCache.cacheInfo()).isStale);
				assert.isFalse(await debtCache.cacheStale());
				assert.isFalse((await issuer.collateralisationRatioAndAnyRatesInvalid(account1))[1]);
				const snapshotStaleTime = await systemSettings.debtSnapshotStaleTime();
				await fastForward(snapshotStaleTime + 10);

				// ensure no actual rates are stale.
				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH, DPS],
					['0.5', '2', '100', '1'].map(toUnit),
					await currentTime(),
					{ from: oracle }
				);

				const info = await debtCache.cacheInfo();
				assert.isFalse(info.isInvalid);
				assert.isTrue(info.isStale);
				assert.isTrue(await debtCache.cacheStale());
				assert.isTrue((await issuer.collateralisationRatioAndAnyRatesInvalid(account1))[1]);

				await systemSettings.setDebtSnapshotStaleTime(snapshotStaleTime + 10000, {
					from: owner,
				});

				assert.isFalse(await debtCache.cacheStale());
				assert.isFalse((await debtCache.cacheInfo()).isStale);
				assert.isFalse((await issuer.collateralisationRatioAndAnyRatesInvalid(account1))[1]);
			});

			it('Rates are reported as invalid when the debt snapshot is uninitisalised', async () => {
				const debtCacheName = toBytes32('DebtCache');

				// Set the stale time to a huge value so that the snapshot will not be stale.
				await systemSettings.setDebtSnapshotStaleTime(toUnit('100'), {
					from: owner,
				});

				const newDebtCache = await setupContract({
					contract: 'DebtCache',
					accounts,
					skipPostDeploy: true,
					args: [owner, addressResolver.address],
				});

				await addressResolver.importAddresses([debtCacheName], [newDebtCache.address], {
					from: owner,
				});
				await newDebtCache.rebuildCache();

				assert.bnEqual(await newDebtCache.cachedDebt(), toUnit('0'));
				assert.bnEqual(await newDebtCache.cachedSynthDebt(dUSD), toUnit('0'));
				assert.bnEqual(await newDebtCache.cacheTimestamp(), toUnit('0'));
				assert.isTrue(await newDebtCache.cacheInvalid());

				const info = await newDebtCache.cacheInfo();
				assert.bnEqual(info.debt, toUnit('0'));
				assert.bnEqual(info.timestamp, toUnit('0'));
				assert.isTrue(info.isInvalid);
				assert.isTrue(info.isStale);
				assert.isTrue(await newDebtCache.cacheStale());

				await issuer.rebuildCache();
				assert.isTrue((await issuer.collateralisationRatioAndAnyRatesInvalid(account1))[1]);
			});

			it('When the debt snapshot is invalid, cannot issue, burn, exchange, claim, or transfer when holding debt.', async () => {
				// Ensure the account has some synths to attempt to burn later.
				await dpassive.transfer(account1, toUnit('1000'), { from: owner });
				await dpassive.transfer(account2, toUnit('1000'), { from: owner });
				await dpassive.issueSynths(toUnit('10'), { from: account1 });

				// Stale the debt snapshot
				const snapshotStaleTime = await systemSettings.debtSnapshotStaleTime();
				await fastForward(snapshotStaleTime + 10);
				// ensure no actual rates are stale.
				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH, DPS],
					['0.5', '2', '100', '1'].map(toUnit),
					await currentTime(),
					{ from: oracle }
				);

				await assert.revert(
					dpassive.issueSynths(toUnit('10'), { from: account1 }),
					'A synth or DPS rate is invalid'
				);

				await assert.revert(
					dpassive.burnSynths(toUnit('1'), { from: account1 }),
					'A synth or DPS rate is invalid'
				);

				await assert.revert(feePool.claimFees(), 'A synth or DPS rate is invalid');

				// Can't transfer DPS if issued debt
				await assert.revert(
					dpassive.transfer(owner, toUnit('1'), { from: account1 }),
					'A synth or DPS rate is invalid'
				);

				// But can transfer if not
				await dpassive.transfer(owner, toUnit('1'), { from: account2 });
			});

			it('will not operate if the system is paused except by the owner', async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				await assert.revert(
					debtCache.takeDebtSnapshot({ from: account1 }),
					'DPassive is suspended'
				);
				await debtCache.takeDebtSnapshot({ from: owner });
			});
		});

		describe('updateCachedSynthDebts()', () => {
			it('allows resynchronisation of subsets of synths', async () => {
				await debtCache.takeDebtSnapshot();

				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH],
					['1', '3', '200'].map(toUnit),
					await currentTime(),
					{
						from: oracle,
					}
				);

				// First try a single currency, ensuring that the others have not been altered.
				const expectedDebts = (await debtCache.currentSynthDebts([dAUD, dEUR, dETH]))[0];

				await debtCache.updateCachedSynthDebts([dAUD]);
				assert.bnEqual(await issuer.totalIssuedSynths(dUSD, true), toUnit(600));
				let debts = await debtCache.cachedSynthDebts([dAUD, dEUR, dETH]);

				assert.bnEqual(debts[0], expectedDebts[0]);
				assert.bnEqual(debts[1], toUnit(200));
				assert.bnEqual(debts[2], toUnit(200));

				// Then a subset
				await debtCache.updateCachedSynthDebts([dEUR, dETH]);
				assert.bnEqual(await issuer.totalIssuedSynths(dUSD, true), toUnit(900));
				debts = await debtCache.cachedSynthDebts([dEUR, dETH]);
				assert.bnEqual(debts[0], expectedDebts[1]);
				assert.bnEqual(debts[1], expectedDebts[2]);
			});

			it('can invalidate the debt cache for individual currencies with invalid rates', async () => {
				// Wait until the exchange rates are stale in order to invalidate the cache.
				const rateStalePeriod = await systemSettings.rateStalePeriod();
				await fastForward(rateStalePeriod + 1000);

				assert.isFalse((await debtCache.cacheInfo()).isInvalid);

				// individual stale rates invalidate the cache
				const tx1 = await debtCache.updateCachedSynthDebts([dAUD]);
				assert.isTrue((await debtCache.cacheInfo()).isInvalid);

				// But even if we update all rates, we can't revalidate the cache using the partial update function
				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH],
					['0.5', '2', '100'].map(toUnit),
					await currentTime(),
					{ from: oracle }
				);
				const tx2 = await debtCache.updateCachedSynthDebts([dAUD, dEUR, dETH]);
				assert.isTrue((await debtCache.cacheInfo()).isInvalid);
				assert.eventEqual(tx1.logs[1], 'DebtCacheValidityChanged', [true]);
				assert.isTrue(tx2.logs.find(log => log.event === 'DebtCacheValidityChanged') === undefined);
			});

			it('properly emits events', async () => {
				await debtCache.takeDebtSnapshot();

				await exchangeRates.updateRates(
					[dAUD, dEUR, dETH],
					['1', '3', '200'].map(toUnit),
					await currentTime(),
					{
						from: oracle,
					}
				);

				const tx = await debtCache.updateCachedSynthDebts([dAUD]);
				assert.eventEqual(tx.logs[0], 'DebtCacheUpdated', [toUnit(600)]);
			});

			it('reverts when attempting to synchronise non-existent synths or DPS', async () => {
				await assert.revert(debtCache.updateCachedSynthDebts([DPS]));
				const fakeSynth = toBytes32('FAKE');
				await assert.revert(debtCache.updateCachedSynthDebts([fakeSynth]));
				await assert.revert(debtCache.updateCachedSynthDebts([dUSD, fakeSynth]));
			});

			it('will not operate if the system is paused except for the owner', async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				await assert.revert(
					debtCache.updateCachedSynthDebts([dAUD, dEUR], { from: account1 }),
					'DPassive is suspended'
				);
				await debtCache.updateCachedSynthDebts([dAUD, dEUR], { from: owner });
			});
		});

		describe('Issuance, burning, exchange, settlement', () => {
			it('issuing dUSD updates the debt total', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const synthsToIssue = toUnit('10');
				await dpassive.transfer(account1, toUnit('1000'), { from: owner });
				const tx = await dpassive.issueSynths(synthsToIssue, { from: account1 });
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.add(synthsToIssue));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [issued.add(synthsToIssue)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});

			it('burning dUSD updates the debt total', async () => {
				await debtCache.takeDebtSnapshot();
				const synthsToIssue = toUnit('10');
				await dpassive.transfer(account1, toUnit('1000'), { from: owner });
				await dpassive.issueSynths(synthsToIssue, { from: account1 });
				const issued = (await debtCache.cacheInfo())[0];

				const synthsToBurn = toUnit('5');

				const tx = await dpassive.burnSynths(synthsToBurn, { from: account1 });
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.sub(synthsToBurn));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [issued.sub(synthsToBurn)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});

			it('exchanging between synths updates the debt totals for those synths', async () => {
				// Zero exchange fees so that we can neglect them.
				await systemSettings.setExchangeFeeRateForSynths([dAUD, dUSD], [toUnit(0), toUnit(0)], {
					from: owner,
				});

				await debtCache.takeDebtSnapshot();
				await dpassive.transfer(account1, toUnit('1000'), { from: owner });
				await dpassive.issueSynths(toUnit('10'), { from: account1 });
				const issued = (await debtCache.cacheInfo())[0];
				const debts = await debtCache.cachedSynthDebts([dUSD, dAUD]);
				const tx = await dpassive.exchange(dUSD, toUnit('5'), dAUD, { from: account1 });
				const postDebts = await debtCache.cachedSynthDebts([dUSD, dAUD]);
				assert.bnEqual((await debtCache.cacheInfo())[0], issued);
				assert.bnEqual(postDebts[0], debts[0].sub(toUnit(5)));
				assert.bnEqual(postDebts[1], debts[1].add(toUnit(5)));

				// As the total debt did not change, no DebtCacheUpdated event was emitted.
				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				assert.isUndefined(logs.find(({ name } = {}) => name === 'DebtCacheUpdated'));
			});

			it('exchanging between synths updates dUSD debt total due to fees', async () => {
				await systemSettings.setExchangeFeeRateForSynths(
					[dAUD, dUSD, dEUR],
					[toUnit(0.1), toUnit(0.1), toUnit(0.1)],
					{ from: owner }
				);

				await dEURContract.issue(account1, toUnit(20));
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const debts = await debtCache.cachedSynthDebts([dUSD, dAUD, dEUR]);

				await dpassive.exchange(dEUR, toUnit(10), dAUD, { from: account1 });
				const postDebts = await debtCache.cachedSynthDebts([dUSD, dAUD, dEUR]);

				assert.bnEqual((await debtCache.cacheInfo())[0], issued);
				assert.bnEqual(postDebts[0], debts[0].add(toUnit(2)));
				assert.bnEqual(postDebts[1], debts[1].add(toUnit(18)));
				assert.bnEqual(postDebts[2], debts[2].sub(toUnit(20)));
			});

			it('exchanging between synths updates debt properly when prices have changed', async () => {
				await systemSettings.setExchangeFeeRateForSynths([dAUD, dUSD], [toUnit(0), toUnit(0)], {
					from: owner,
				});

				await dEURContract.issue(account1, toUnit(20));
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const debts = await debtCache.cachedSynthDebts([dAUD, dEUR]);

				await exchangeRates.updateRates([dAUD, dEUR], ['1', '1'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				await dpassive.exchange(dEUR, toUnit(10), dAUD, { from: account1 });
				const postDebts = await debtCache.cachedSynthDebts([dAUD, dEUR]);

				// 120 eur @ $2 = $240 and 100 aud @ $0.50 = $50 becomes:
				// 110 eur @ $1 = $110 (-$130) and 110 aud @ $1 = $110 (+$60)
				// Total debt is reduced by $130 - $60 = $70
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.sub(toUnit(70)));
				assert.bnEqual(postDebts[0], debts[0].add(toUnit(60)));
				assert.bnEqual(postDebts[1], debts[1].sub(toUnit(130)));
			});

			it('settlement updates debt totals', async () => {
				await systemSettings.setExchangeFeeRateForSynths([dAUD, dEUR], [toUnit(0), toUnit(0)], {
					from: owner,
				});
				await dAUDContract.issue(account1, toUnit(100));
				await debtCache.takeDebtSnapshot();

				await dpassive.exchange(dAUD, toUnit(50), dEUR, { from: account1 });

				await exchangeRates.updateRates([dAUD, dEUR], ['2', '1'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const tx = await exchanger.settle(account1, dAUD);
				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				// AU$150 worth $75 became worth $300
				// But the EUR debt does not change due to settlement,
				// and remains at $200 + $25 from the exchange

				const results = await debtCache.cachedSynthDebts([dAUD, dEUR]);
				assert.bnEqual(results[0], toUnit(300));
				assert.bnEqual(results[1], toUnit(225));

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [toUnit(825)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
		});

		describe('Synth removal and addition', () => {
			it('Removing synths zeroes out the debt snapshot for that currency', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];
				const dEURValue = (await debtCache.cachedSynthDebts([dEUR]))[0];
				await dEURContract.setTotalSupply(toUnit(0));
				const tx = await issuer.removeSynth(dEUR, { from: owner });
				const result = (await debtCache.cachedSynthDebts([dEUR]))[0];
				const newIssued = (await debtCache.cacheInfo())[0];
				assert.bnEqual(newIssued, issued.sub(dEURValue));
				assert.bnEqual(result, toUnit(0));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [newIssued],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});

			it('Synth snapshots cannot be purged while the synth exists', async () => {
				await assert.revert(debtCache.purgeCachedSynthDebt(dAUD, { from: owner }), 'Synth exists');
			});

			it('Synth snapshots can be purged without updating the snapshot', async () => {
				const debtCacheName = toBytes32('DebtCache');
				const newDebtCache = await setupContract({
					contract: 'TestableDebtCache',
					accounts,
					skipPostDeploy: true,
					args: [owner, addressResolver.address],
				});
				await addressResolver.importAddresses([debtCacheName], [newDebtCache.address], {
					from: owner,
				});
				await newDebtCache.rebuildCache();
				await newDebtCache.takeDebtSnapshot();
				const issued = (await newDebtCache.cacheInfo())[0];

				const fakeTokenKey = toBytes32('FAKE');

				// Set a cached snapshot value
				await newDebtCache.setCachedSynthDebt(fakeTokenKey, toUnit('1'));

				// Purging deletes the value
				assert.bnEqual(await newDebtCache.cachedSynthDebt(fakeTokenKey), toUnit(1));
				await newDebtCache.purgeCachedSynthDebt(fakeTokenKey, { from: owner });
				assert.bnEqual(await newDebtCache.cachedSynthDebt(fakeTokenKey), toUnit(0));

				// Without affecting the snapshot.
				assert.bnEqual((await newDebtCache.cacheInfo())[0], issued);
			});

			it('Removing a synth invalidates the debt cache', async () => {
				await dEURContract.setTotalSupply(toUnit('0'));
				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.removeSynth(dEUR, { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Adding a synth invalidates the debt cache', async () => {
				const { token: synth } = await mockToken({
					accounts,
					synth: 'dXYZ',
					skipInitialAllocation: true,
					supply: 0,
					name: 'XYZ',
					symbol: 'XYZ',
				});

				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.addSynth(synth.address, { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Adding multiple synths invalidates the debt cache', async () => {
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

				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.addSynths([synth1.address, synth2.address], { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Removing multiple synths invalidates the debt cache', async () => {
				await dAUDContract.setTotalSupply(toUnit('0'));
				await dEURContract.setTotalSupply(toUnit('0'));

				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.removeSynths([dEUR, dAUD], { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Removing multiple synths zeroes the debt cache for those currencies', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];
				const dEURValue = (await debtCache.cachedSynthDebts([dEUR]))[0];
				const dAUDValue = (await debtCache.cachedSynthDebts([dAUD]))[0];
				await dEURContract.setTotalSupply(toUnit(0));
				await dAUDContract.setTotalSupply(toUnit(0));
				const tx = await issuer.removeSynths([dEUR, dAUD], { from: owner });
				const result = await debtCache.cachedSynthDebts([dEUR, dAUD]);
				const newIssued = (await debtCache.cacheInfo())[0];
				assert.bnEqual(newIssued, issued.sub(dEURValue.add(dAUDValue)));
				assert.bnEqual(result[0], toUnit(0));
				assert.bnEqual(result[1], toUnit(0));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [newIssued],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
		});

		describe('updateDebtCacheValidity()', () => {
			beforeEach(async () => {
				// Ensure the cache is valid.
				await debtCache.takeDebtSnapshot();

				// Change the calling address in the addressResolver so that the calls don't fail.
				const issuerName = toBytes32('Issuer');
				await addressResolver.importAddresses([issuerName], [account1], {
					from: owner,
				});
				await debtCache.rebuildCache();
			});

			describe('when the debt cache is valid', () => {
				it('invalidates the cache', async () => {
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(true, { from: account1 });
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					decodedEventEqual({
						event: 'DebtCacheValidityChanged',
						emittedFrom: debtCache.address,
						args: [true],
						log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
					});
				});

				it('does nothing if attempting to re-validate the cache', async () => {
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(false, { from: account1 });
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					assert.isUndefined(logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'));
				});
			});

			describe('when the debt cache is invalid', () => {
				beforeEach(async () => {
					// Invalidate the cache first.
					await debtCache.updateDebtCacheValidity(true, { from: account1 });
				});

				it('re-validates the cache', async () => {
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(false, { from: account1 });
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					decodedEventEqual({
						event: 'DebtCacheValidityChanged',
						emittedFrom: debtCache.address,
						args: [false],
						log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
					});
				});

				it('does nothing if attempting to invalidate the cache', async () => {
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(true, { from: account1 });
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					assert.isUndefined(logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'));
				});
			});
		});
	});

	describe('totalNonDpsBackedDebt', async () => {
		let totalNonDpsBackedDebt;
		let currentDebt;

		const gettotalNonDpsBackedDebt = async () => {
			const { excludedDebt } = await debtCache.totalNonDpsBackedDebt();
			return excludedDebt;
		};

		beforeEach(async () => {
			// Issue some debt to avoid a division-by-zero in `getBorrowRate` where
			// we compute the utilisation.
			await dpassive.transfer(account1, toUnit('1000'), { from: owner });
			await dpassive.issueSynths(toUnit('10'), { from: account1 });

			totalNonDpsBackedDebt = await gettotalNonDpsBackedDebt();
			currentDebt = await debtCache.currentDebt();
		});

		describe('when MultiCollateral loans are opened', async () => {
			let rate;

			beforeEach(async () => {
				await setupMultiCollateral();

				({ rate } = await exchangeRates.rateAndInvalid(dETH));

				await ceth.open(oneETH, dETH, {
					value: twoETH,
					from: account1,
				});
			});

			it('increases non-DPS debt', async () => {
				assert.bnEqual(
					totalNonDpsBackedDebt.add(multiplyDecimalRound(oneETH, rate)),
					await gettotalNonDpsBackedDebt()
				);
			});
			it('is excluded from currentDebt', async () => {
				assert.bnEqual(currentDebt, await debtCache.currentDebt());
			});

			describe('after the synths are exchanged into other synths', async () => {
				beforeEach(async () => {
					// Swap some dETH into synthetic dollarydoos.
					await dpassive.exchange(dETH, '5', dAUD, { from: account1 });
				});

				it('non-DPS debt is unchanged', async () => {
					assert.bnEqual(
						totalNonDpsBackedDebt.add(multiplyDecimalRound(oneETH, rate)),
						await gettotalNonDpsBackedDebt()
					);
				});
				it('currentDebt is unchanged', async () => {
					assert.bnEqual(currentDebt, await debtCache.currentDebt());
				});
			});
		});

		describe('when EtherCollateral loans are opened', async () => {
			let rate;

			beforeEach(async () => {
				({ rate } = await exchangeRates.rateAndInvalid(dETH));

				// Collateralization is 100%, meaning we mint the full value in
				// dETH.
				await etherCollateral.setCollateralizationRatio(toUnit('100'), { from: owner });
				await etherCollateral.openLoan({
					value: oneETH,
					from: account1,
				});
			});

			it('increases non-DPS debt', async () => {
				assert.bnEqual(
					totalNonDpsBackedDebt.add(multiplyDecimalRound(oneETH, rate)),
					await gettotalNonDpsBackedDebt()
				);
			});
			it('is excluded from currentDebt', async () => {
				assert.bnEqual(currentDebt, await debtCache.currentDebt());
			});
		});

		describe('when EtherCollateraldUSD loans are opened', async () => {
			let rate;
			const amount = toUnit('1');

			beforeEach(async () => {
				// ETH rate must be updated.
				await exchangeRates.updateRates([ETH], ['200'].map(toUnit), timestamp, { from: oracle });

				({ rate } = await exchangeRates.rateAndInvalid(ETH));

				// Collateralization is 100%, meaning we mint the full value in
				// dETH.
				await etherCollateraldUSD.setCollateralizationRatio(toUnit('100'), { from: owner });
				await etherCollateraldUSD.setIssueFeeRate(toUnit('0'), { from: owner });
				await etherCollateraldUSD.openLoan(amount, {
					value: rate,
					from: account1,
				});
			});

			it('increases non-DPS debt', async () => {
				assert.bnEqual(totalNonDpsBackedDebt.add(amount), await gettotalNonDpsBackedDebt());
			});
			it('is excluded from currentDebt', async () => {
				assert.bnEqual(currentDebt, await debtCache.currentDebt());
			});
		});

		describe('when shorts are opened', async () => {
			let rate;
			let amount;

			beforeEach(async () => {
				({ rate } = await exchangeRates.rateAndInvalid(dETH));

				// Take out a short position on dETH.
				// dUSD collateral = 1.5 * rate_eth
				amount = multiplyDecimalRound(rate, toUnit('1.5'));
				await dUSDContract.issue(account1, amount, { from: owner });
				// Again, avoid a divide-by-zero in computing the short rate,
				// by ensuring dETH.totalSupply() > 0.
				await dETHContract.issue(account1, amount, { from: owner });

				await setupShort();
				await short.setMinCratio(toUnit(1.5), { from: owner });
				await short.setIssueFeeRate(toUnit('0'), { from: owner });
				await short.open(amount, oneETH, dETH, { from: account1 });
			});

			it('increases non-DPS debt', async () => {
				assert.bnEqual(totalNonDpsBackedDebt.add(rate), await gettotalNonDpsBackedDebt());
			});
			it('is excluded from currentDebt', async () => {
				assert.bnEqual(currentDebt, await debtCache.currentDebt());
			});
		});
	});
});
