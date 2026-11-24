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

// isAny: full control with no delay.
export const proxiesOf = async (api, account) => {
  const [proxies] = await api.query.proxy.proxies(account);
  return proxies.map((p) => ({
    delegate: encodeAddress(p.delegate, SS58),
    type: p.proxyType.toString(),
    delay: p.delay.toNumber(),
    isAny: p.proxyType.index === PROXY_TYPE_ANY && p.delay.isZero(),
  }));
};

export const pendingCalls = async (api, multisig) =>
  (await api.query.multisig.multisigs.entries(multisig)).map(([key, op]) => ({ callHash: key.args[1].toHex(), op: op.unwrap() }));

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

const isCall = (arg) => arg?.callIndex instanceof Uint8Array && !!arg.section;
const callsIn = (arg) => (isCall(arg) ? [arg] : Array.isArray(arg) && arg.length && arg.every(isCall) ? [...arg] : []);

// The call, then every call nested in it (proxy.proxy, as_multi, batch, …), each with its depth.
export function* callTree(call, depth = 0) {
  yield { call, depth };
  for (const arg of call.args) for (const child of callsIn(arg)) yield* callTree(child, depth + 1);
}

const addressOf = (arg, type) =>
  type === 'AccountId32' ? encodeAddress(arg, SS58) : type === 'MultiAddress' && arg.type === 'Id' ? encodeAddress(arg.value, SS58) : null;

const MAX_ARG_TEXT = 200;

// One entry per argument that is not a nested call. Balances show as 9-decimal units and raw.
export const callArgs = (call) =>
  call.args.flatMap((arg, i) => {
    if (callsIn(arg).length) return [];
    const { name, type, typeName } = call.meta.args[i];
    const hint = `${typeName} ${name}`;
    const address = addressOf(arg, type.toString());
    const isBalance = /^(Compact<)?u(64|128)>?$/.test(type.toString()) && /balance|currency|amount|value|price/i.test(hint);
    const json = arg.toJSON();
    const plain = typeof json === 'string' ? json : JSON.stringify(json);
    const text = address ?? (isBalance
      ? `${raoToTao(arg.toString())} ${/alpha|unstaked/i.test(hint) ? 'alpha' : 'TAO'} (${arg.toString()} rao)`
      : plain.length > MAX_ARG_TEXT ? `${plain.slice(0, MAX_ARG_TEXT)}… (${plain.length} chars)` : plain);
    return [{ name: name.toString(), address, text }];
  });

// The account a proxy.proxy call runs as; null when the call is not proxied.
export const proxiedReal = (api, call) => {
  if (!api.tx.proxy.proxy.is(call)) return null;
  const real = addressOf(call.args[0], 'MultiAddress');
  if (!real) throw new Error('proxy.proxy real must be a plain account id');
  return real;
};

// The pending entry stores only the call hash; the opener's as_multi extrinsic carries the full call.
export const findOpenedCall = async (api, when, callHash) => {
  const { block } = await api.rpc.chain.getBlock(await api.rpc.chain.getBlockHash(when.height));
  const opener = block.extrinsics[when.index.toNumber()];
  for (const { call } of opener ? callTree(opener.method) : [])
    if (api.tx.multisig.asMulti.is(call) && call.args[3].hash.toHex() === callHash) return call.args[3];
  return null;
};

export const describeCall = (call) => JSON.stringify(call.method.toHuman(), null, 2);
