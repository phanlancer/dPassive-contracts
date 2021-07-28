const { getPrivateKey } = require('./users');

const commands = {
	build: require('../../../publish/src/commands/build').build,
	deploy: require('../../../publish/src/commands/deploy').deploy,
};

async function compileInstance() {
	await commands.build({
		optimizerRuns: 200,
		testHelpers: true,
	});
}

async function deployInstance({ providerUrl, providerPort, ignoreCustomParameters = false }) {
	const privateKey = getPrivateKey({ index: 0 });

	await commands.deploy({
		concurrency: 1,
		network: 'local',
		freshDeploy: true,
		yes: true,
		providerUrl: `${providerUrl}:${providerPort}`,
		gasPrice: '1',
		privateKey,
		methodCallGasLimit: '3500000',
		contractDeploymentGasLimit: '9500000',
		ignoreCustomParameters,
	});
}

module.exports = {
	compileInstance,
	deployInstance,
};
