# dPassive

dPassive is a crypto-backed asset platform.

It is a multi-token system, powered by DPS, the dPassive Native Token. DPS holders can stake DPS to issue Synths, on-chain assets via the [dPassive dApp](https://bsc.dpassive.finance)
Synths can be traded using [dPassive dApp](https://bsc.dpassive.finance)

dPassive uses a proxy system so that upgrades will not be disruptive to the functionality of the contract. This smooths user interaction, since new functionality will become available without any interruption in their experience. It is also transparent to the community at large, since each upgrade is accompanied by events announcing those upgrades. New releases are managed via the [dPassive Improvement Proposal (DIP)] system similar to the [EF's EIPs](https://eips.ethereum.org/all)

Prices are committed on chain by a trusted oracle. Moving to a decentralised oracle is phased in with the first phase completed for all forex prices using [Chainlink](https://feeds.chain.link/)

Please note that this repository is under development.

### Solidity API

All interfaces are available via the path [`dpassive-core-contracts/contracts/interfaces`](./contracts/interfaces/).

:zap: In your code, the key is to use `IAddressResolver`. You can then fetch `dPassive`, `FeePool`, `Depot`, et al via `IAddressResolver.getAddress(bytes32 name)` where `name` is the `bytes32` version of the contract name (case-sensitive). Or you can fetch any synth using `IAddressResolver.getSynth(bytes32 synth)` where `synth` is the `bytes32` name of the synth (e.g. `dETH`, `dUSD`, `dDEFI`).
