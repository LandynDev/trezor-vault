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

export const pendingMultisig = async (api, multisig, callHash) => {
  const entry = await api.query.multisig.multisigs(multisig, callHash);
  return entry.isSome ? entry.unwrap() : null;
};

// Builds as_multi for `signer`: opens when nothing is pending, else approves (and executes at threshold).
export const buildAsMulti = async (api, { signers, threshold, signer, call }) => {
  const multisig = multisigAddress(signers, threshold);
  const callHash = call.method.hash.toHex();
  const pending = await pendingMultisig(api, multisig, callHash);
  if (pending && pending.approvals.some((a) => a.eq(decodeAddress(signer))))
    throw new Error(`${signer} already approved ${callHash}`);
  const { weight } = await call.paymentInfo(multisig);
  const timepoint = pending ? { height: pending.when.height, index: pending.when.index } : null;
  const asMulti = api.tx.multisig.asMulti(threshold, otherSignatories(signers, signer), timepoint, call.method, weight);
  return { callHash, pending, asMulti };
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

const isCall = (value) => value?.callIndex instanceof Uint8Array && !!value.section;
const isAccount = (value) => value instanceof Uint8Array && value.length === 32 && value.toRawType?.() === 'AccountId';

const plain = (value) => {
  const json = value.toJSON();
  return typeof json === 'string' && json ? json : JSON.stringify(json);
};

// Renders a value in full, by type. Reports every account id and every call inside it.
const render = (value, found, label) => {
  const all = (items) => items.map((item) => render(item, found, label)).join(', ');
  if (isCall(value)) return found.calls.push(value) && '<call below>';
  if (isAccount(value)) {
    const address = encodeAddress(value, SS58);
    found.addresses.push(address);
    return label(address);
  }
  // Enum first: a variant with no payload also reports isNone.
  if (typeof value.type === 'string' && typeof value.index === 'number' && value.value?.toRawType) {
    if (value.type === 'Id' && isAccount(value.value)) return render(value.value, found, label);
    return value.isBasic || value.value.toRawType() === 'Null' ? value.type : `${value.type}(${render(value.value, found, label)})`;
  }
  if (value.isNone === true) return 'null';
  // Option, Compact and decoded wrappers hold one value.
  if (typeof value.unwrap === 'function' && value.isDecoded !== false) return render(value.unwrap(), found, label);
  if (value instanceof Map) return `{${[...value].map(([key, item]) => `${typeof key === 'string' ? key : render(key, found, label)}: ${render(item, found, label)}`).join(', ')}}`;
  if (value instanceof Set || Array.isArray(value)) return `[${all([...value])}]`;
  return plain(value);
};

// args: one entry per argument that is not purely calls, shown in full. calls: every call nested in the arguments.
// Balances show as 9-decimal units and raw.
export const callParts = (call, label = (address) => address) => {
  const calls = [];
  // Root (netuid 0) stake is TAO. The limit price of a swap or move is an alpha ratio: shown raw.
  const fromRoot = call.args.some((arg, i) => /^(origin)?netuid$/i.test(call.meta.args[i].name) && arg.toString() === '0');
  const hasRatioLimit = /^(swap|move)Stake/.test(call.method);
  const args = call.args.flatMap((arg, i) => {
    const { name, type, typeName } = call.meta.args[i];
    const hint = `${typeName} ${name}`;
    const found = { calls, addresses: [] };
    const isRatio = hasRatioLimit && name.eq('limitPrice');
    const isBalance = !isRatio && /^(Compact<)?u(64|128)>?$/.test(type.toString()) && /balance|currency|amount|value|price/i.test(hint);
    const text = isBalance
      ? `${raoToTao(arg.toString())} ${/alpha|unstaked/i.test(hint) && !fromRoot ? 'alpha' : 'TAO'} (${arg.toString()} rao)`
      : render(arg, found, label);
    const onlyCalls = isCall(arg) || (Array.isArray(arg) && arg.length > 0 && arg.every(isCall));
    return onlyCalls ? [] : [{ name: name.toString(), text, addresses: found.addresses }];
  });
  return { args, calls };
};

export const callName = (call) => `${call.section}.${call.method}`;

// The account a proxy.proxy call runs its inner call as; null when it is not a plain account id.
const realOf = (call) => (call.args[0].type === 'Id' ? encodeAddress(call.args[0].value, SS58) : null);

const KEEPS_ORIGIN = ['utility.batch', 'utility.batchAll', 'utility.forceBatch'];

// The call, then every call nested in it, each with its depth and the account it runs as.
// origin is null when this tool cannot tell. real is set on proxy.proxy only.
export function* callTree(call, origin = null, depth = 0) {
  const isProxy = callName(call) === 'proxy.proxy';
  const real = isProxy ? realOf(call) : undefined;
  yield { call, origin, depth, real };
  const inner = isProxy ? real : KEEPS_ORIGIN.includes(callName(call)) ? origin : null;
  for (const child of callParts(call).calls) yield* callTree(child, inner, depth + 1);
}

// The pending entry stores only the call hash; the opener's as_multi extrinsic carries the full call.
export const findOpenedCall = async (api, when, callHash) => {
  const { block } = await api.rpc.chain.getBlock(await api.rpc.chain.getBlockHash(when.height));
  const opener = block.extrinsics[when.index.toNumber()];
  for (const { call } of opener ? callTree(opener.method) : [])
    if (api.tx.multisig.asMulti.is(call) && call.args[3].hash.toHex() === callHash) return call.args[3];
  return null;
};

export const describeCall = (call) => JSON.stringify(call.method.toHuman(), null, 2);
