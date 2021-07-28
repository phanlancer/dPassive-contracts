'use strict';

const { contract } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupContract } = require('./setup');

const { toUnit } = require('../utils')();

const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

contract('DPassiveState', async accounts => {
	const [, owner, account1, account2] = accounts;

	let dpassiveState;

	before(async () => {
		dpassiveState = await setupContract({
			accounts,
			contract: 'DPassiveState',
		});
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: dpassiveState.abi,
			ignoreParents: ['State', 'LimitedSetup'],
			expected: [
				'setCurrentIssuanceData',
				'clearIssuanceData',
				'incrementTotalIssuerCount',
				'decrementTotalIssuerCount',
				'appendDebtLedgerValue',
			],
		});
	});
	it('should set constructor params on deployment', async () => {
		const instance = await setupContract({
			accounts,
			contract: 'DPassiveState',
			args: [account1, account2],
		});

		assert.equal(await instance.owner(), account1);
		assert.equal(await instance.associatedContract(), account2);
	});

	describe('setCurrentIssuanceData()', () => {
		it('should allow the associated contract to setCurrentIssuanceData', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });
			await dpassiveState.setCurrentIssuanceData(account2, toUnit('0.1'), { from: account1 });
		});

		it('should disallow another from setting the setCurrentIssuanceData', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: dpassiveState.setCurrentIssuanceData,
				args: [account2, toUnit('0.1')],
				accounts,
				skipPassCheck: true,
				reason: 'Only the associated contract can perform this action',
			});
		});
	});

	describe('clearIssuanceData()', () => {
		it('should allow the associated contract to clearIssuanceData', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });
			await dpassiveState.setCurrentIssuanceData(account2, toUnit('0.1'), { from: account1 });
			await dpassiveState.clearIssuanceData(account2, { from: account1 });
			assert.bnEqual((await dpassiveState.issuanceData(account2)).initialDebtOwnership, 0);
		});

		it('should disallow another address from calling clearIssuanceData', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });
			await assert.revert(dpassiveState.clearIssuanceData(account2, { from: account2 }));
		});

		it('should disallow another from setting the setCurrentIssuanceData', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: dpassiveState.clearIssuanceData,
				args: [account2],
				accounts,
				skipPassCheck: true,
				reason: 'Only the associated contract can perform this action',
			});
		});
	});

	describe('incrementTotalIssuerCount()', () => {
		it('should allow the associated contract to incrementTotalIssuerCount', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });

			await dpassiveState.incrementTotalIssuerCount({ from: account1 });
			assert.bnEqual(await dpassiveState.totalIssuerCount(), 1);
		});

		it('should disallow another address from calling incrementTotalIssuerCount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: dpassiveState.incrementTotalIssuerCount,
				accounts,
				args: [],
				skipPassCheck: true,
				reason: 'Only the associated contract can perform this action',
			});
		});
	});

	describe('decrementTotalIssuerCount()', () => {
		it('should allow the associated contract to decrementTotalIssuerCount', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });

			// We need to increment first or we'll overflow on subtracting from zero and revert that way
			await dpassiveState.incrementTotalIssuerCount({ from: account1 });
			await dpassiveState.decrementTotalIssuerCount({ from: account1 });
			assert.bnEqual(await dpassiveState.totalIssuerCount(), 0);
		});

		it('should disallow another address from calling decrementTotalIssuerCount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: dpassiveState.decrementTotalIssuerCount,
				accounts,
				args: [],
				skipPassCheck: true,
				reason: 'Only the associated contract can perform this action',
			});
		});
	});

	describe('appendDebtLedgerValue()', () => {
		it('should allow the associated contract to appendDebtLedgerValue', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });

			await dpassiveState.appendDebtLedgerValue(toUnit('0.1'), { from: account1 });
			assert.bnEqual(await dpassiveState.lastDebtLedgerEntry(), toUnit('0.1'));
		});

		it('should disallow another address from calling appendDebtLedgerValue', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: dpassiveState.appendDebtLedgerValue,
				accounts,
				args: [toUnit('0.1')],
				skipPassCheck: true,
				reason: 'Only the associated contract can perform this action',
			});
		});
	});

	describe('debtLedgerLength()', () => {
		it('should correctly report debtLedgerLength', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });

			assert.bnEqual(await dpassiveState.debtLedgerLength(), 0);
			await dpassiveState.appendDebtLedgerValue(toUnit('0.1'), { from: account1 });
			assert.bnEqual(await dpassiveState.debtLedgerLength(), 1);
		});
	});

	describe('lastDebtLedgerEntry()', () => {
		it('should correctly report lastDebtLedgerEntry', async () => {
			await dpassiveState.setAssociatedContract(account1, { from: owner });

			// Nothing in the array, so we should revert on invalid opcode
			await assert.invalidOpcode(dpassiveState.lastDebtLedgerEntry());
			await dpassiveState.appendDebtLedgerValue(toUnit('0.1'), { from: account1 });
			assert.bnEqual(await dpassiveState.lastDebtLedgerEntry(), toUnit('0.1'));
		});
	});

	describe('hasIssued()', () => {
		it('is false by default', async () => {
			assert.equal(await dpassiveState.hasIssued(account2), false);
		});
		describe('when an account has issuance data', () => {
			beforeEach(async () => {
				await dpassiveState.setAssociatedContract(account1, { from: owner });
				await dpassiveState.setCurrentIssuanceData(account2, toUnit('0.1'), { from: account1 });
			});
			it('then hasIssued() is true', async () => {
				assert.equal(await dpassiveState.hasIssued(account2), true);
			});
		});
	});
});
