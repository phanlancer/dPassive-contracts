'use strict';

const w3utils = require('web3-utils');
const abiDecoder = require('abi-decoder');

// load the data in explicitly (not programmatically) so webpack knows what to bundle
const data = {
	kovan: require('./publish/deployed/kovan'),
	rinkeby: require('./publish/deployed/rinkeby'),
	ropsten: require('./publish/deployed/ropsten'),
	mainnet: require('./publish/deployed/mainnet'),
	goerli: require('./publish/deployed/goerli'),
	bsc_testnet: require('./publish/deployed/bsc_testnet'),
};

const assets = require('./publish/assets.json');
const nonUpgradeable = require('./publish/non-upgradeable.json');
const releases = require('./publish/releases.json');

const networks = [
	'local',
	'kovan',
	'rinkeby',
	'ropsten',
	'mainnet',
	'goerli',
	'bsc',
	'bsc_testnet',
];

const chainIdMapping = Object.entries({
	1: {
		network: 'mainnet',
	},
	3: {
		network: 'ropsten',
	},
	4: {
		network: 'rinkeby',
	},
	5: {
		network: 'goerli',
	},
	42: {
		network: 'kovan',
	},
	56: {
		network: 'bsc',
	},
	97: {
		network: 'bsc_testnet',
	},

	// Hardhat fork of mainnet: https://hardhat.org/config/#hardhat-network
	31337: {
		network: 'mainnet',
		fork: true,
	},
	// now append any defaults
}).reduce((memo, [id, body]) => {
	memo[id] = Object.assign({ fork: false }, body);
	return memo;
}, {});

const getNetworkFromId = ({ id }) => chainIdMapping[id];

const networkToChainId = Object.entries(chainIdMapping).reduce((memo, [id, { network, fork }]) => {
	memo[network + (fork ? '-fork' : '')] = id;
	return memo;
}, {});

const constants = {
	BUILD_FOLDER: 'build',
	CONTRACTS_FOLDER: 'contracts',
	COMPILED_FOLDER: 'compiled',
	FLATTENED_FOLDER: 'flattened',
	AST_FOLDER: 'ast',

	CONFIG_FILENAME: 'config.json',
	PARAMS_FILENAME: 'params.json',
	SYNTHS_FILENAME: 'synths.json',
	STAKING_REWARDS_FILENAME: 'rewards.json',
	SHORTING_REWARDS_FILENAME: 'shorting-rewards.json',
	OWNER_ACTIONS_FILENAME: 'owner-actions.json',
	DEPLOYMENT_FILENAME: 'deployment.json',
	VERSIONS_FILENAME: 'versions.json',
	FEEDS_FILENAME: 'feeds.json',

	AST_FILENAME: 'asts.json',

	ZERO_ADDRESS: '0x' + '0'.repeat(40),
	ZERO_BYTES32: '0x' + '0'.repeat(64),

	inflationStartTimestampInSecs: 1551830400, // 2019-03-06T00:00:00Z
};

const knownAccounts = {
	mainnet: [
		{
			name: 'binance', // Binance 8 Wallet
			address: '0xF977814e90dA44bFA03b6295A0616a897441aceC',
		},
		{
			name: 'renBTCWallet', // KeeperDAO wallet (has renBTC and ETH)
			address: '0x35ffd6e268610e764ff6944d07760d0efe5e40e5',
		},
		{
			name: 'loansAccount',
			address: '0x62f7A1F94aba23eD2dD108F8D23Aa3e7d452565B',
		},
	],
	rinkeby: [],
	kovan: [],
};

// The solidity defaults are managed here in the same format they will be stored, hence all
// numbers are converted to strings and those with 18 decimals are also converted to wei amounts
const defaults = {
	WAITING_PERIOD_SECS: (60 * 5).toString(), // 5 mins
	PRICE_DEVIATION_THRESHOLD_FACTOR: w3utils.toWei('3'),
	TRADING_REWARDS_ENABLED: false,
	ISSUANCE_RATIO: w3utils
		.toBN(1)
		.mul(w3utils.toBN(1e18))
		.div(w3utils.toBN(6))
		.toString(), // 1/6 = 0.16666666667
	FEE_PERIOD_DURATION: (3600 * 24 * 7).toString(), // 1 week
	TARGET_THRESHOLD: '1', // 1% target threshold (it will be converted to a decimal when set)
	LIQUIDATION_DELAY: (3600 * 24 * 3).toString(), // 3 days
	LIQUIDATION_RATIO: w3utils.toWei('0.5'), // 200% cratio
	LIQUIDATION_PENALTY: w3utils.toWei('0.1'), // 10% penalty
	RATE_STALE_PERIOD: (3600 * 25).toString(), // 25 hours
	EXCHANGE_FEE_RATES: {
		forex: w3utils.toWei('0.003'),
		commodity: w3utils.toWei('0.003'),
		equities: w3utils.toWei('0.003'),
		crypto: w3utils.toWei('0.01'),
		index: w3utils.toWei('0.01'),
	},
	MINIMUM_STAKE_TIME: (3600 * 24).toString(), // 1 days
	DEBT_SNAPSHOT_STALE_TIME: (43800).toString(), // 12 hour heartbeat + 10 minutes mining time
	AGGREGATOR_WARNING_FLAGS: {
		mainnet: '0x4A5b9B4aD08616D11F3A402FF7cBEAcB732a76C6',
		kovan: '0x6292aa9a6650ae14fbf974e5029f36f95a1848fd',
	},
	RENBTC_ERC20_ADDRESSES: {
		mainnet: '0xEB4C2781e4ebA804CE9a9803C67d0893436bB27D',
		kovan: '0x9B2fE385cEDea62D839E4dE89B0A23EF4eacC717',
		rinkeby: '0xEDC0C23864B041607D624E2d9a67916B6cf40F7a',
		bsc: '0xfce146bf3146100cfe5db4129cf6c82b0ef4ad8c',
		bsc_testnet: '0x9fb98c633814c8ff907b19ee3d41d182b9ebfa60',
	},
	WETH_ERC20_ADDRESSES: {
		mainnet: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
		kovan: '0xd0A1E359811322d97991E03f863a0C30C2cF029C',
		rinkeby: '0xc778417E063141139Fce010982780140Aa0cD5Ab',
		ropsten: '0xc778417E063141139Fce010982780140Aa0cD5Ab',
		goerli: '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6',
		bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
		bsc_testnet: '0x094616f0bdfb0b526bd735bf66eca0ad254ca81f',
	},
	INITIAL_ISSUANCE: w3utils.toWei(`${100e6}`),
	CROSS_DOMAIN_DEPOSIT_GAS_LIMIT: `${3e6}`,
	CROSS_DOMAIN_ESCROW_GAS_LIMIT: `${8e6}`,
	CROSS_DOMAIN_REWARD_GAS_LIMIT: `${3e6}`,
	CROSS_DOMAIN_WITHDRAWAL_GAS_LIMIT: `${3e6}`,

	COLLATERAL_MANAGER: {
		SYNTHS: ['dUSD', 'dBTC', 'dETH'],
		SHORTS: [
			{ long: 'dBTC', short: 'iBTC' },
			{ long: 'dETH', short: 'iETH' },
		],
		MAX_DEBT: w3utils.toWei('75000000'), // 75 million dUSD
		BASE_BORROW_RATE: Math.round((0.005 * 1e18) / 31556926).toString(), // 31556926 is CollateralManager seconds per year
		BASE_SHORT_RATE: Math.round((0.005 * 1e18) / 31556926).toString(),
	},
	COLLATERAL_ETH: {
		SYNTHS: ['dUSD', 'dETH'],
		MIN_CRATIO: w3utils.toWei('1.3'),
		MIN_COLLATERAL: w3utils.toWei('2'),
		ISSUE_FEE_RATE: w3utils.toWei('0.001'),
	},
	COLLATERAL_RENBTC: {
		SYNTHS: ['dUSD', 'dBTC'],
		MIN_CRATIO: w3utils.toWei('1.3'),
		MIN_COLLATERAL: w3utils.toWei('0.05'),
		ISSUE_FEE_RATE: w3utils.toWei('0.001'),
	},
	COLLATERAL_SHORT: {
		SYNTHS: ['dBTC', 'dETH'],
		MIN_CRATIO: w3utils.toWei('1.2'),
		MIN_COLLATERAL: w3utils.toWei('1000'),
		ISSUE_FEE_RATE: w3utils.toWei('0.005'),
		INTERACTION_DELAY: '3600', // 1 hour in secs
	},

	ETHER_WRAPPER_MAX_ETH: w3utils.toWei('5000'),
	ETHER_WRAPPER_MINT_FEE_RATE: w3utils.toWei('0.02'), // 200 bps
	ETHER_WRAPPER_BURN_FEE_RATE: w3utils.toWei('0.0005'), // 5 bps
};

/**
 * Converts a string into a hex representation of bytes32, with right padding
 */
const toBytes32 = key => w3utils.rightPad(w3utils.asciiToHex(key), 64);
const fromBytes32 = key => w3utils.hexToAscii(key);

const getFolderNameForNetwork = ({ network }) => {
	return network;
};

const getPathToNetwork = ({ network = 'mainnet', file = '', path } = {}) =>
	path.join(__dirname, 'publish', 'deployed', getFolderNameForNetwork({ network }), file);

// Pass in fs and path to avoid webpack wrapping those
const loadDeploymentFile = ({ network, path, fs, deploymentPath }) => {
	if (!deploymentPath && network !== 'local' && (!path || !fs)) {
		return data[getFolderNameForNetwork({ network })].deployment;
	}
	const pathToDeployment = deploymentPath
		? path.join(deploymentPath, constants.DEPLOYMENT_FILENAME)
		: getPathToNetwork({ network, path, file: constants.DEPLOYMENT_FILENAME });

	if (!fs.existsSync(pathToDeployment)) {
		throw Error(`Cannot find deployment for network: ${network}.`);
	}
	return JSON.parse(fs.readFileSync(pathToDeployment));
};

/**
 * Retrieve the list of targets for the network - returning the name, address, source file and link to etherscan
 */
const getTarget = ({ network = 'mainnet', contract, path, fs, deploymentPath } = {}) => {
	const deployment = loadDeploymentFile({ network, path, fs, deploymentPath });
	if (contract) return deployment.targets[contract];
	else return deployment.targets;
};

/**
 * Retrieve the list of solidity sources for the network - returning the abi and bytecode
 */
const getSource = ({ network = 'mainnet', contract, path, fs, deploymentPath } = {}) => {
	const deployment = loadDeploymentFile({ network, path, fs, deploymentPath });
	if (contract) return deployment.sources[contract];
	else return deployment.sources;
};

/**
 * Retrieve the ASTs for the source contracts
 */
const getAST = ({ source, path, fs, match = /^contracts\// } = {}) => {
	let fullAST;
	if (path && fs) {
		const pathToAST = path.resolve(
			__dirname,
			constants.BUILD_FOLDER,
			constants.AST_FOLDER,
			constants.AST_FILENAME
		);
		if (!fs.existsSync(pathToAST)) {
			throw Error('Cannot find AST');
		}
		fullAST = JSON.parse(fs.readFileSync(pathToAST));
	} else {
		// Note: The below cannot be required as the build folder is not stored
		// in code (only in the published module).
		// The solution involves tracking these after each commit in another file
		// somewhere persisted in the codebase - JJM
		// 		data.ast = require('./build/ast/asts.json'),
		if (!data.ast) {
			throw Error('AST currently not supported in browser mode');
		}
		fullAST = data.ast;
	}

	// remove anything not matching the pattern
	const ast = Object.entries(fullAST)
		.filter(([astEntryKey]) => match.test(astEntryKey))
		.reduce((memo, [key, val]) => {
			memo[key] = val;
			return memo;
		}, {});

	if (source && source in ast) {
		return ast[source];
	} else if (source) {
		// try to find the source without a path
		const [key, entry] =
			Object.entries(ast).find(([astEntryKey]) => astEntryKey.includes('/' + source)) || [];
		if (!key || !entry) {
			throw Error(`Cannot find AST entry for source: ${source}`);
		}
		return { [key]: entry };
	} else {
		return ast;
	}
};

const getFeeds = ({ network, path, fs, deploymentPath } = {}) => {
	let feeds;

	if (!deploymentPath && network !== 'local' && (!path || !fs)) {
		feeds = data[getFolderNameForNetwork({ network })].feeds;
	} else {
		const pathToFeeds = deploymentPath
			? path.join(deploymentPath, constants.FEEDS_FILENAME)
			: getPathToNetwork({
					network,
					path,
					file: constants.FEEDS_FILENAME,
			  });
		if (!fs.existsSync(pathToFeeds)) {
			throw Error(`Cannot find feeds file.`);
		}
		feeds = JSON.parse(fs.readFileSync(pathToFeeds));
	}

	const synths = getSynths({ network, path, fs, deploymentPath, skipPopulate: true });

	// now mix in the asset data
	return Object.entries(feeds).reduce((memo, [asset, entry]) => {
		memo[asset] = Object.assign(
			// standalone feeds are those without a synth using them
			// Note: ETH still used as a rate for Depot, can remove the below once the Depot uses dETH rate or is
			// removed from the system
			{ standalone: !synths.find(synth => synth.asset === asset) || asset === 'ETH' },
			assets[asset],
			entry
		);
		return memo;
	}, {});
};

/**
 * Retrieve ths list of synths for the network - returning their names, assets underlying, category, sign, description, and
 * optional index and inverse properties
 */
const getSynths = ({
	network = 'mainnet',
	path,
	fs,
	deploymentPath,
	skipPopulate = false,
} = {}) => {
	let synths;

	if (!deploymentPath && network !== 'local' && (!path || !fs)) {
		synths = data[getFolderNameForNetwork({ network })].synths;
	} else {
		const pathToSynthList = deploymentPath
			? path.join(deploymentPath, constants.SYNTHS_FILENAME)
			: getPathToNetwork({ network, path, file: constants.SYNTHS_FILENAME });
		if (!fs.existsSync(pathToSynthList)) {
			throw Error(`Cannot find synth list.`);
		}
		synths = JSON.parse(fs.readFileSync(pathToSynthList));
	}

	if (skipPopulate) {
		return synths;
	}

	const feeds = getFeeds({ network, path, fs, deploymentPath });

	// copy all necessary index parameters from the longs to the corresponding shorts
	return synths.map(synth => {
		// mixin the asset details
		synth = Object.assign({}, assets[synth.asset], synth);

		if (feeds[synth.asset]) {
			const { feed } = feeds[synth.asset];

			synth = Object.assign({ feed }, synth);
		}

		if (synth.inverted) {
			synth.description = `Inverse ${synth.description}`;
		}
		// replace an index placeholder with the index details
		if (typeof synth.index === 'string') {
			const { index } = synths.find(({ name }) => name === synth.index) || {};
			if (!index) {
				throw Error(
					`While processing ${synth.name}, it's index mapping "${synth.index}" cannot be found - this is an error in the deployment config and should be fixed`
				);
			}
			synth = Object.assign({}, synth, { index });
		}

		if (synth.index) {
			synth.index = synth.index.map(indexEntry => {
				return Object.assign({}, assets[indexEntry.asset], indexEntry);
			});
		}

		return synth;
	});
};

/**
 * Retrieve the list of staking rewards for the network - returning this names, stakingToken, and rewardToken
 */
const getStakingRewards = ({ network = 'mainnet', path, fs, deploymentPath } = {}) => {
	if (!deploymentPath && network !== 'local' && (!path || !fs)) {
		return data[getFolderNameForNetwork({ network })].rewards;
	}

	const pathToStakingRewardsList = deploymentPath
		? path.join(deploymentPath, constants.STAKING_REWARDS_FILENAME)
		: getPathToNetwork({
				network,
				path,
				file: constants.STAKING_REWARDS_FILENAME,
		  });
	if (!fs.existsSync(pathToStakingRewardsList)) {
		return [];
	}
	return JSON.parse(fs.readFileSync(pathToStakingRewardsList));
};

/**
 * Retrieve the list of shorting rewards for the network - returning the names and rewardTokens
 */
const getShortingRewards = ({ network = 'mainnet', path, fs, deploymentPath } = {}) => {
	if (!deploymentPath && network !== 'local' && (!path || !fs)) {
		return data[getFolderNameForNetwork({ network })]['shorting-rewards'];
	}

	const pathToShortingRewardsList = deploymentPath
		? path.join(deploymentPath, constants.SHORTING_REWARDS_FILENAME)
		: getPathToNetwork({
				network,
				path,
				file: constants.SHORTING_REWARDS_FILENAME,
		  });
	if (!fs.existsSync(pathToShortingRewardsList)) {
		return [];
	}
	return JSON.parse(fs.readFileSync(pathToShortingRewardsList));
};

/**
 * Retrieve the list of system user addresses
 */
const getUsers = ({ network = 'mainnet', user } = {}) => {
	const testnetOwner = '0x73570075092502472e4b61a7058df1a4a1db12f2';
	const base = {
		owner: testnetOwner,
		deployer: testnetOwner,
		marketClosure: testnetOwner,
		oracle: '0xac1e8B385230970319906C03A1d8567e3996d1d5',
		fee: '0xfeEFEEfeefEeFeefEEFEEfEeFeefEEFeeFEEFEeF',
		zero: '0x' + '0'.repeat(40),
	};

	const map = {
		mainnet: Object.assign({}, base, {
			owner: '0xEb3107117FEAd7de89Cd14D463D340A2E6917769',
			deployer: '0xDe910777C787903F78C89e7a0bf7F4C435cBB1Fe',
			marketClosure: '0xC105Ea57Eb434Fbe44690d7Dec2702e4a2FBFCf7',
			oracle: '0xaC1ED4Fabbd5204E02950D68b6FC8c446AC95362',
		}),
		kovan: Object.assign({}, base),
		rinkeby: Object.assign({}, base),
		ropsten: Object.assign({}, base),
		goerli: Object.assign({}, base),
		bsc: Object.assign({}, base),
		bsc_testnet: Object.assign({}, base),
		local: Object.assign({}, base, {
			// Deterministic account #0 when using `npx hardhat node`
			owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
		}),
	};

	const users = Object.entries(map[getFolderNameForNetwork({ network })]).map(([key, value]) => ({
		name: key,
		address: value,
	}));

	return user ? users.find(({ name }) => name === user) : users;
};

const getVersions = ({
	network = 'mainnet',
	path,
	fs,
	deploymentPath,
	byContract = false,
} = {}) => {
	let versions;

	if (!deploymentPath && network !== 'local' && (!path || !fs)) {
		versions = data[getFolderNameForNetwork({ network })].versions;
	} else {
		const pathToVersions = deploymentPath
			? path.join(deploymentPath, constants.VERSIONS_FILENAME)
			: getPathToNetwork({ network, path, file: constants.VERSIONS_FILENAME });
		if (!fs.existsSync(pathToVersions)) {
			throw Error(`Cannot find versions for network.`);
		}
		versions = JSON.parse(fs.readFileSync(pathToVersions));
	}

	if (byContract) {
		// compile from the contract perspective
		return Object.values(versions).reduce(
			(memo, { tag, release, date, commit, block, contracts }) => {
				for (const [contract, contractEntry] of Object.entries(contracts)) {
					memo[contract] = memo[contract] || [];
					memo[contract].push(Object.assign({ tag, release, date, commit, block }, contractEntry));
				}
				return memo;
			},
			{}
		);
	}
	return versions;
};

const getSuspensionReasons = ({ code = undefined } = {}) => {
	const suspensionReasonMap = {
		1: 'System Upgrade',
		2: 'Market Closure',
		4: 'iSynth Reprice',
		55: 'Circuit Breaker (Phase one)',
		65: 'Decentralized Circuit Breaker (Phase two)',
		99999: 'Emergency',
	};

	return code ? suspensionReasonMap[code] : suspensionReasonMap;
};

/**
 * Retrieve the list of tokens used in the dPassive protocol
 */
const getTokens = ({ network = 'mainnet', path, fs } = {}) => {
	const synths = getSynths({ network, path, fs });
	const targets = getTarget({ network, path, fs });
	const feeds = getFeeds({ network, path, fs });

	return [
		Object.assign(
			{
				symbol: 'DPS',
				asset: 'DPS',
				name: 'dPassive',
				address: targets.ProxyERC20.address,
				decimals: 18,
			},
			feeds['DPS'].feed ? { feed: feeds['DPS'].feed } : {}
		),
	].concat(
		synths
			.filter(({ category }) => category !== 'internal')
			.map(synth => ({
				symbol: synth.name,
				asset: synth.asset,
				name: synth.description,
				address: (targets[`Proxy${synth.name === 'dUSD' ? 'ERC20dUSD' : synth.name}`] || {})
					.address,
				index: synth.index,
				inverted: synth.inverted,
				decimals: 18,
				feed: synth.feed,
			}))
			.sort((a, b) => (a.symbol > b.symbol ? 1 : -1))
	);
};

const decode = ({ network = 'mainnet', fs, path, data, target } = {}) => {
	const sources = getSource({ network, path, fs });
	for (const { abi } of Object.values(sources)) {
		abiDecoder.addABI(abi);
	}
	const targets = getTarget({ network, path, fs });
	let contract;
	if (target) {
		contract = Object.values(targets).filter(
			({ address }) => address.toLowerCase() === target.toLowerCase()
		)[0].name;
	}
	return { method: abiDecoder.decodeMethod(data), contract };
};

const wrap = ({ network, deploymentPath, fs, path }) =>
	[
		'decode',
		'getAST',
		'getPathToNetwork',
		'getSource',
		'getStakingRewards',
		'getShortingRewards',
		'getFeeds',
		'getSynths',
		'getTarget',
		'getTokens',
		'getUsers',
		'getVersions',
	].reduce((memo, fnc) => {
		memo[fnc] = (prop = {}) =>
			module.exports[fnc](Object.assign({ network, deploymentPath, fs, path }, prop));
		return memo;
	}, {});

module.exports = {
	chainIdMapping,
	constants,
	decode,
	defaults,
	getAST,
	getNetworkFromId,
	getPathToNetwork,
	getSource,
	getStakingRewards,
	getShortingRewards,
	getSuspensionReasons,
	getFeeds,
	getSynths,
	getTarget,
	getTokens,
	getUsers,
	getVersions,
	networks,
	networkToChainId,
	toBytes32,
	fromBytes32,
	wrap,
	nonUpgradeable,
	releases,
	knownAccounts,
};
