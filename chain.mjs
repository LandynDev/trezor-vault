import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aConcat, u8aToHex, stringToU8a, hexToU8a } from '@polkadot/util';
import { blake2AsU8a, createKeyMulti, decodeAddress, encodeAddress, sortAddresses } from '@polkadot/util-crypto';
import { Interface } from 'ethers';

export const NETWORKS = {
  test: { ws: 'wss://test.finney.opentensor.ai:443', rpc: 'https://test.chain.opentensor.ai', chainId: 945 },
  main: { ws: 'wss://entrypoint-finney.opentensor.ai:443', rpc: 'https://lite.chain.opentensor.ai', chainId: 964 },
};

export const PROXY_PRECOMPILE = '0x000000000000000000000000000000000000080b';
export const PROXY_TYPE_ANY = 0;
export const SS58 = 42;
export const RAO = 1_000_000_000n;

export const proxyAbi = new Interface([
  'function createPureProxy(uint8 proxyType, uint32 delay, uint16 index) returns (bytes32)',
  'function proxyCall(bytes32 real, uint8[] forceProxyType, uint8[] call)',
]);

export const connect = (net) =>
  ApiPromise.create({ provider: new WsProvider(NETWORKS[net].ws), noInitWarn: true });

// pallet_evm::HashedAddressMapping<BlakeTwo256>
export const mirrorOf = (h160) =>
  encodeAddress(blake2AsU8a(u8aConcat(stringToU8a('evm:'), hexToU8a(h160)), 256), SS58);

export const toBytes32 = (ss58) => u8aToHex(decodeAddress(ss58));

// User-supplied addresses must carry the chain's ss58 prefix; decodeAddress reports the mismatch.
export const ss58Of = (address) => {
  decodeAddress(address, false, SS58);
  return address;
};

export const multisigAddress = (signers, threshold) => encodeAddress(createKeyMulti(signers, threshold), SS58);

export const otherSignatories = (signers, me) =>
  sortAddresses(signers.filter((s) => toBytes32(s) !== toBytes32(me)), SS58);

// Transfer amounts only: strict positive base-10 decimal, at most 9 fractional digits.
export const taoToRao = (tao) => {
  if (!/^\d+(\.\d{1,9})?$/.test(String(tao))) throw new Error(`invalid TAO amount: ${tao}`);
  const [whole, frac = ''] = String(tao).split('.');
  const rao = BigInt(whole) * RAO + BigInt(frac.padEnd(9, '0'));
  if (rao === 0n) throw new Error('amount must be greater than 0');
  return rao;
};

export const raoToTao = (rao) => {
  const r = BigInt(rao);
  return `${r / RAO}.${(r % RAO).toString().padStart(9, '0')}`;
};

export const pendingMultisig = async (api, vault, callHash) => {
  const entry = await api.query.multisig.multisigs(vault, callHash);
  return entry.isSome ? entry.unwrap() : null;
};

// Builds as_multi for `signer`: opens when nothing is pending, else approves (and executes at threshold).
export const buildAsMulti = async (api, { signers, threshold, signer, call }) => {
  const vault = multisigAddress(signers, threshold);
  const callHash = call.method.hash.toHex();
  const pending = await pendingMultisig(api, vault, callHash);
  if (pending && pending.approvals.some((a) => a.eq(decodeAddress(signer))))
    throw new Error(`${signer} already approved ${callHash}`);
  const { weight } = await call.paymentInfo(vault);
  const timepoint = pending ? { height: pending.when.height, index: pending.when.index } : null;
  const asMulti = api.tx.multisig.asMulti(threshold, otherSignatories(signers, signer), timepoint, call.method, weight);
  return { vault, callHash, pending, asMulti };
};

export const proxyCallData = (real, call) =>
  proxyAbi.encodeFunctionData('proxyCall', [toBytes32(real), [], Array.from(call.method.toU8a())]);

export const createPureProxyData = (index) =>
  proxyAbi.encodeFunctionData('createPureProxy', [PROXY_TYPE_ANY, 0, index]);

// PureCreated is emitted in the block that included the EVM tx; height + ext index are needed to kill it later.
export const findPureCreated = async (api, blockNumber, spawner, index) => {
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const events = await (await api.at(hash)).query.system.events();
  const hit = events.find(
    ({ event }) =>
      api.events.proxy.PureCreated.is(event) &&
      encodeAddress(event.data.who, SS58) === spawner &&
      event.data.proxyType.index === PROXY_TYPE_ANY &&
      event.data.disambiguationIndex.toNumber() === index,
  );
  if (!hit) throw new Error(`no PureCreated(Any, index ${index}) for ${spawner} in block ${blockNumber}`);
  return {
    pure: encodeAddress(hit.event.data.pure, SS58),
    height: Number(blockNumber),
    extIndex: hit.phase.asApplyExtrinsic.toNumber(),
    index: hit.event.data.disambiguationIndex.toNumber(),
  };
};

export const describeCall = (call) => JSON.stringify(call.method.toHuman(), null, 2);
