#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { encodeAddress } from '@polkadot/util-crypto';
import {
  PROXY_PRECOMPILE, PROXY_TYPE_ANY, SS58, buildAsMulti, callArgs, callTree, connect, createPureProxyData, describeCall,
  findPureCreated, mirrorOf, multisigAddress, pendingCalls, proxiesOf, proxyCallData, raoToTao, ss58Of, taoToRao,
} from './chain.mjs';
import { send } from './send.mjs';

const USAGE = `usage: node vault.mjs <command> [--net test|main]
  mirror <h160>                                         ss58 mirror of an EVM address
  address --signers a,b,c [--threshold 2]               multisig (vault) address
  create-signer --from <h160> [--index 0]               spawn the Trezor's pure proxy (trezor-signer)
  pending --signers a,b,c [--threshold 2]               list open vault calls
  delegates <ss58>                                      proxies and free balance of an account
  sign --from <h160> --signer <trezor-signer> --signers a,b,c [--threshold 2] [--proxy-for <ss58>]
       (--transfer-to <ss58> --amount <tao> | --create-vault [--index 0] |
        --add-delegate <ss58> | --remove-delegate <ss58> | --call <0xhex>)
                                                        open/approve a vault call through the Trezor
                                                        --proxy-for: run the call as a pure proxy the multisig controls
                                                        --create-vault: spawn such a pure proxy from the multisig`;

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    net: { type: 'string', default: 'test' }, from: { type: 'string' },
    index: { type: 'string', default: '0' }, signers: { type: 'string' }, threshold: { type: 'string', default: '2' },
    signer: { type: 'string' }, 'transfer-to': { type: 'string' }, amount: { type: 'string' }, call: { type: 'string' },
    'proxy-for': { type: 'string' }, 'create-vault': { type: 'boolean' },
    'add-delegate': { type: 'string' }, 'remove-delegate': { type: 'string' },
  },
});

const need = (name) => {
  if (!opt[name]) throw new Error(`--${name} is required\n\n${USAGE}`);
  return opt[name];
};
const signersOpt = () => need('signers').split(',').map((s) => ss58Of(s.trim()));
const thresholdOpt = () => Number(opt.threshold);

const innerCalls = {
  'transfer-to': (api) => api.tx.balances.transferKeepAlive(ss58Of(opt['transfer-to']), taoToRao(need('amount'))),
  'create-vault': (api) => api.tx.proxy.createPure('Any', 0, Number(opt.index)),
  'add-delegate': (api) => api.tx.proxy.addProxy(ss58Of(opt['add-delegate']), 'Any', 0),
  'remove-delegate': (api) => api.tx.proxy.removeProxy(ss58Of(opt['remove-delegate']), 'Any', 0),
  call: (api) => api.tx(api.createType('Call', opt.call)),
};

const delegateLine = (p) => `${p.delegate} (${p.type}, delay ${p.delay})`;

const assertAnyDelegate = async (api, real, delegate) => {
  const proxies = await proxiesOf(api, real);
  // Exactly one delegate: any extra delegate could act in its place.
  const ok = proxies.length === 1 && proxies[0].delegate === delegate && proxies[0].isAny;
  if (!ok) throw new Error(`${real} must have exactly one proxy: ${delegate} (Any, delay 0). Found: ${proxies.map(delegateLine).join(', ') || 'none'}`);
};

// Checks every account the call depends on. Returns the delegates of `real`.
const checkAccounts = async (api, { from, signer, controller, real, inner }) => {
  await assertAnyDelegate(api, signer, mirrorOf(from));
  const delegates = real ? await proxiesOf(api, real) : [];
  const holdsAny = (who) => delegates.some((p) => p.isAny && p.delegate === who);
  if (real && !holdsAny(controller)) throw new Error(`${controller} is not an Any, delay 0 delegate of ${real}`);
  for (const { call } of real ? callTree(inner) : []) {
    if (api.tx.proxy.removeProxies.is(call)) throw new Error(`refusing: proxy.removeProxies removes every delegate of ${real}`);
    if (!api.tx.proxy.removeProxy.is(call) || call.args[1].index !== PROXY_TYPE_ANY || !call.args[2].isZero()) continue;
    const leaving = callArgs(call)[0].address;
    if (!holdsAny(leaving)) throw new Error(`${leaving} is not an Any, delay 0 delegate of ${real}`);
    // A pure proxy has no key: with no Any delegate left, its funds are lost forever.
    if (!delegates.some((p) => p.isAny && p.delegate !== leaving)) throw new Error(`refusing: ${leaving} is the last Any, delay 0 delegate of ${real}`);
  }
  return delegates;
};

// Names a module error (pallet.Error) when the runtime knows it.
const errorText = (api, error) => {
  if (!error.isModule) return error.toString();
  const { section, name, docs } = api.registry.findMetaError(error.asModule);
  return `${section}.${name} (${docs.join(' ').trim()})`;
};

// Returns true when this signature executed the call.
const reportMultisig = async (api, blockNumber, { controller, signer, callHash }) => {
  const events = await (await api.at(await api.rpc.chain.getBlockHash(blockNumber))).query.system.events();
  const mine = events.filter(({ event }) =>
    event.section === 'multisig' && encodeAddress(event.data.multisig, SS58) === controller &&
    event.data.approving?.eq(signer) && event.data.callHash.toHex() === callHash);
  if (!mine.length) throw new Error(`no multisig event for ${controller} by ${signer} in block ${blockNumber}`);
  for (const { event } of mine) console.log(`${event.method} ${JSON.stringify(event.data.toHuman())}`);
  const failed = mine.find(({ event }) => api.events.multisig.MultisigExecuted.is(event) && event.data.result.isErr);
  if (failed) throw new Error(`vault call executed but FAILED: ${errorText(api, failed.event.data.result.asErr)}`);
  // A failed inner call still yields MultisigExecuted Ok; its ProxyExecuted carries the error.
  const failedProxy = events.find(({ phase, event }) =>
    phase.eq(mine[0].phase) && api.events.proxy.ProxyExecuted.is(event) && event.data.result.isErr);
  if (failedProxy) throw new Error(`proxied call FAILED: ${errorText(api, failedProxy.event.data.result.asErr)}`);
  return mine.some(({ event }) => api.events.multisig.MultisigExecuted.is(event));
};

// Shows the summary, sends as_multi through the Trezor, then checks the result.
const signAsMulti = async (api, { from, signer, signers, threshold, real, delegates, call, callSummary }) => {
  const controller = multisigAddress(signers, threshold);
  const { callHash, pending, asMulti } = await buildAsMulti(api, { signers, threshold, signer, call });
  const approvals = pending ? pending.approvals.length : 0;
  const action = approvals + 1 >= threshold ? 'EXECUTE' : pending ? 'APPROVE' : 'OPEN';
  if (!pending) console.warn('warning: no open call found; the Trezor signer will open it and pay the deposit');
  const summary = [
    `controller ${controller} (${threshold}-of-${signers.length} multisig)`,
    real && `real       ${real} (the call runs as this account)`,
    real && `delegates  ${delegates.map(delegateLine).join(', ')}`,
    delegates.length > 1 && `WARNING    ${real} has ${delegates.length} delegates; EACH ONE can move its funds`,
    `signers    ${signers.join(', ')}`,
    `signing as ${signer} (trezor-signer)`,
    `action     ${action} (${approvals}/${threshold} approvals before this)`,
    `timepoint  ${pending ? `${pending.when.height}-${pending.when.index}` : 'none (opens new call)'}`,
    `call hash  ${callHash}   <- must match the other signer`,
    ...callSummary,
  ].filter(Boolean).join('\n');
  console.log(summary);
  const receipt = await send({ net: opt.net, from, to: PROXY_PRECOMPILE, data: proxyCallData(signer, asMulti), summary });
  const executed = await reportMultisig(api, receipt.blockNumber, { controller, signer, callHash });
  return { executed, receipt };
};

const commands = {
  mirror: async ([h160]) => console.log(mirrorOf(h160)),

  address: async () => console.log(multisigAddress(signersOpt(), thresholdOpt())),

  'create-signer': async () => {
    const from = need('from');
    const spawner = mirrorOf(from);
    const api = await connect(opt.net);
    try {
      const summary = `create trezor-signer (pure proxy, type Any, delay 0, index ${opt.index})\nspawner mirror ${spawner}`;
      console.log(summary);
      const receipt = await send({ net: opt.net, from, to: PROXY_PRECOMPILE, data: createPureProxyData(Number(opt.index)), summary });
      const pure = await findPureCreated(api, receipt.blockNumber, spawner, Number(opt.index));
      await assertAnyDelegate(api, pure.pure, spawner);
      console.log('\nRECORD THIS (needed to kill it later):');
      console.log(JSON.stringify({ trezorSigner: pure.pure, spawner, h160: from, ...pure }, null, 2));
    } finally {
      await api.disconnect();
    }
  },

  pending: async () => {
    const api = await connect(opt.net);
    try {
      const vault = multisigAddress(signersOpt(), thresholdOpt());
      const open = await pendingCalls(api, vault);
      console.log(`vault ${vault}: ${open.length} pending`);
      for (const { callHash, op } of open)
        console.log(`- hash ${callHash} opened at ${op.when.height}-${op.when.index} by ${encodeAddress(op.depositor, SS58)}, ${op.approvals.length} approvals`);
    } finally {
      await api.disconnect();
    }
  },

  delegates: async ([account]) => {
    if (!account) throw new Error(`<ss58> is required\n\n${USAGE}`);
    const real = ss58Of(account);
    const api = await connect(opt.net);
    try {
      const proxies = await proxiesOf(api, real);
      const { data } = await api.query.system.account(real);
      console.log(`${real}: ${raoToTao(data.free)} TAO free, ${proxies.length} delegates`);
      for (const p of proxies) console.log(`- ${delegateLine(p)}`);
    } finally {
      await api.disconnect();
    }
  },

  sign: async () => {
    const from = need('from');
    const signer = ss58Of(need('signer'));
    const signers = signersOpt();
    const threshold = thresholdOpt();
    if (!signers.includes(signer)) throw new Error(`--signer ${signer} is not in --signers`);
    const kinds = Object.keys(innerCalls).filter((k) => opt[k]);
    if (kinds.length !== 1) throw new Error(`give exactly one of ${Object.keys(innerCalls).map((k) => `--${k}`).join(', ')}\n\n${USAGE}`);
    const [kind] = kinds;
    const real = opt['proxy-for'] && ss58Of(opt['proxy-for']);
    if (kind === 'create-vault' && real) throw new Error('--create-vault is not allowed with --proxy-for');
    if (kind.endsWith('-delegate') && !real) throw new Error(`--${kind} requires --proxy-for`);
    const controller = multisigAddress(signers, threshold);
    const api = await connect(opt.net);
    try {
      const inner = innerCalls[kind](api);
      const delegates = await checkAccounts(api, { from, signer, controller, real, inner: inner.method });
      const call = real ? api.tx.proxy.proxy(real, null, inner) : inner;
      const callSummary = [`call       ${describeCall(inner)}`, kind === 'transfer-to' && `amount     ${raoToTao(taoToRao(opt.amount))} TAO`];
      const { executed, receipt } = await signAsMulti(api, { from, signer, signers, threshold, real, delegates, call, callSummary });
      if (kind !== 'create-vault') return;
      if (!executed) return console.log('\nvault not created yet: RECORD THIS prints for the executing signer');
      const { pure: vault, ...created } = await findPureCreated(api, receipt.blockNumber, controller, Number(opt.index));
      await assertAnyDelegate(api, vault, controller);
      console.log('\nRECORD THIS (needed to kill it later):');
      console.log(JSON.stringify({ vault, controller, ...created }, null, 2));
    } finally {
      await api.disconnect();
    }
  },

};

const [cmd, ...rest] = positionals;
if (!commands[cmd]) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
if (opt.net !== 'test' && opt.net !== 'main') throw new Error('--net must be test or main');
await commands[cmd](rest);
process.exit(0);
