const { subtask, task } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');
const { yellow, red } = require('chalk');

const optimizeIfRequired = require('../util/optimizeIfRequired');

const { collectContractBytesCodes } = require('../util/collectContractBytecodes');
const { logContractSizes } = require('../../publish/src/contract-size');

task('compile')
	.addFlag('showsize', 'Show size of compiled contracts')
	.addFlag('optimizer', 'Compile with the optimizer')
	.addFlag('failOversize', 'Fail if any contract is oversize')
	.addFlag('native', 'Compile with the native solc compiler')
	.setAction(async (taskArguments, hre, runSuper) => {
		if (taskArguments.native) {
			hre.config.solc.native = true;
		}

		optimizeIfRequired({ hre, taskArguments });

		await runSuper(taskArguments);

		if (taskArguments.showsize || taskArguments.failOversize) {
			const contractToObjectMap = collectContractBytesCodes();
			const sizes = logContractSizes({ contractToObjectMap });

			if (taskArguments.failOversize) {
				const offenders = sizes.filter(entry => +entry.pcent.split('%')[0] > 100);
				if (offenders.length > 0) {
					const names = offenders.map(o => o.file);
					console.log(red('Oversized contracts:'), yellow(`[${names}]`));
					throw new Error(
						'Compilation failed, because some contracts are too big to be deployed. See above.'
					);
				}
			}
		}
	});

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(({ solcVersion }, hre, runSuper) => {
	return runSuper();
	// if (solcVersion === '0.4.25') {
	// 	return runSuper();
	// }

	// const compilerPath = path.resolve(__dirname, 'node_modules', 'solc', 'soljson.js');

	// return {
	// 	compilerPath,
	// 	isSolcJs: true,
	// 	version: solcVersion,
	// 	longVersion: solcVersion,
	// };
});
