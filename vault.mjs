#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { encodeAddress } from '@polkadot/util-crypto';
import {
  PROXY_PRECOMPILE, PROXY_TYPE_ANY, SS58, buildAsMulti, callParts, callTree, connect, createPureProxyData, describeCall,
  findOpenedCall, findPureCreated, mirrorOf, multisigAddress, pendingCalls, proxiesOf, proxyCallData,
  raoToTao, ss58Of, taoToRao,
} from './chain.mjs';
import { loadVault, vaultFlags } from './config.mjs';
import { send } from './send.mjs';

const USAGE = `usage: node vault.mjs <command> [--net test|main] [--vault <name>]
  --vault <name>                                        fill --net --from --signer --signers --threshold --proxy-for
                                                        from ~/.trezor-vault/vaults.json
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
                                                        --create-vault: spawn such a pure proxy from the multisig
  approve --vault <name> [--hash <0x…>] [--call <0xhex>]
                                                        approve an open vault call; the call is read from the chain
  info --vault <name>                                   vault balance, delegates, stake and open calls
  config-check --vault <name>                           check the vault config against the chain`;

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    net: { type: 'string' }, from: { type: 'string' }, vault: { type: 'string' }, hash: { type: 'string' },
    index: { type: 'string' }, signers: { type: 'string' }, threshold: { type: 'string' },
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
    const [leaving] = callParts(call).args[0].addresses;
    if (!holdsAny(leaving)) throw new Error(`${leaving} is not an Any, delay 0 delegate of ${real}`);
    // A pure proxy has no key: with no Any delegate left, its funds are lost forever.
    if (!delegates.some((p) => p.isAny && p.delegate !== leaving)) throw new Error(`refusing: ${leaving} is the last Any, delay 0 delegate of ${real}`);
  }
  return delegates;
};

const labelsOf = ({ vault, controller, signers, signer }) =>
  new Map([
    ...signers.map((s, i) => [s, s === signer ? 'your Trezor signer' : `signer ${i + 1}`]),
    [controller, 'multisig'],
    ...(vault ? [[vault, 'vault']] : []),
  ]);

const labelled = (address, labels) => (labels.has(address) ? `${address} (${labels.get(address)})` : address);
const callName = (call) => `${call.section}.${call.method}`;

// One line per call level: pallet.method(arg=value, …).
const callLines = (call, labels) =>
  [...callTree(call)].map(({ call: c, depth }) =>
    `${'  '.repeat(depth)}${callName(c)}(${callParts(c, (address) => labelled(address, labels)).args.map((a) => `${a.name}=${a.text}`).join(', ')})`);

const CONTROL_CALLS = ['proxy.addProxy', 'proxy.removeProxy', 'proxy.removeProxies', 'proxy.killPure', 'multisig.cancelAsMulti', 'balances.transferAll', 'balances.transferAllowDeath'];

const callWarnings = (call, { real, vault, labels }) => {
  const calls = [...callTree(call)].map((node) => node.call);
  return [
    !real && 'the call is NOT wrapped in proxy.proxy: it runs as the multisig itself, not as the vault',
    real && real !== vault && `the call runs as ${real}, which is NOT the configured vault ${vault ?? '(none given)'}`,
    ...calls.filter((c) => CONTROL_CALLS.includes(callName(c))).map((c) => `${callName(c)} changes who controls the account or moves its whole balance`),
    ...calls.flatMap((c) => callParts(c).args.flatMap((a) => a.addresses.filter((address) => !labels.has(address))
      .map((address) => `unknown address ${address} (${callName(c)} ${a.name}): check every character`))),
  ].filter(Boolean);
};

const pendingLine = async (api, { callHash, op }, labels) => {
  const call = await findOpenedCall(api, op.when, callHash);
  const head = `- hash ${callHash} opened at ${op.when.height}-${op.when.index} by ${labelled(encodeAddress(op.depositor, SS58), labels)}, ${op.approvals.length} approvals`;
  return `${head}\n  ${call ? callLines(call, labels).map((line) => line.trim()).join(' > ') : 'call data is not on chain'}`;
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
const signAsMulti = async (api, { from, signer, signers, threshold, real, delegates, call, callSummary, mayOpen }) => {
  const controller = multisigAddress(signers, threshold);
  const { callHash, pending, asMulti } = await buildAsMulti(api, { signers, threshold, signer, call });
  if (!pending && !mayOpen) throw new Error(`call ${callHash} is no longer pending`);
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
  return { executed, receipt, approvals: approvals + 1 };
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
      const { executed, receipt } = await signAsMulti(api, { from, signer, signers, threshold, real, delegates, call, callSummary, mayOpen: true });
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

  approve: async () => {
    const from = need('from');
    const signer = ss58Of(need('signer'));
    const signers = signersOpt();
    const threshold = thresholdOpt();
    if (!signers.includes(signer)) throw new Error(`--signer ${signer} is not in --signers`);
    const vault = opt['proxy-for'] && ss58Of(opt['proxy-for']);
    const controller = multisigAddress(signers, threshold);
    const labels = labelsOf({ vault, controller, signers, signer });
    const api = await connect(opt.net);
    try {
      const open = await pendingCalls(api, controller);
      if (!open.length) return console.log(`multisig ${controller}: no pending calls`);
      const wanted = opt.hash ? open.filter((p) => p.callHash === opt.hash.toLowerCase()) : open;
      if (wanted.length !== 1) {
        console.log(`multisig ${controller}: ${open.length} pending`);
        for (const p of open) console.log(await pendingLine(api, p, labels));
        throw new Error(wanted.length ? 'more than one pending call: run again with --hash <0x…>' : `no pending call with hash ${opt.hash}`);
      }
      const [{ callHash, op }] = wanted;
      const found = opt.call ? api.createType('Call', opt.call) : await findOpenedCall(api, op.when, callHash);
      if (!found) throw new Error(`the call data of ${callHash} is not on chain (block ${op.when.height}, extrinsic ${op.when.index}).\nThe opener used the MEV shield or approve_as_multi. Open the call again with --no-mev-shield on btcli, or pass --call <0xhex>.`);
      if (found.hash.toHex() !== callHash) throw new Error(`--call has hash ${found.hash.toHex()}; the pending call is ${callHash}`);
      // Decode again with the current runtime: that is what executes.
      const call = api.tx(api.createType('Call', found.toHex()));
      const [{ real }] = callTree(call.method);
      if (real === null) throw new Error('proxy.proxy real must be a plain account id');
      const inner = real ? call.method.args[2] : call.method;
      const delegates = await checkAccounts(api, { from, signer, controller, real, inner });
      const [first, ...rest] = callLines(call.method, labels);
      const callSummary = [
        `call       ${first}`,
        ...rest.map((line) => `           ${line}`),
        ...callWarnings(call.method, { real, vault, labels }).map((warning) => `WARNING    ${warning}`),
      ];
      const { executed, approvals } = await signAsMulti(api, { from, signer, signers, threshold, real, delegates, call, callSummary });
      if (!executed) console.log(`\napproved, NOT executed: ${approvals}/${threshold} approvals. Another signer must approve.`);
    } finally {
      await api.disconnect();
    }
  },

  info: async () => {
    const vault = ss58Of(need('proxy-for'));
    const signers = signersOpt();
    const controller = multisigAddress(signers, thresholdOpt());
    const labels = labelsOf({ vault, controller, signers, signer: opt.signer });
    const api = await connect(opt.net);
    try {
      const proxies = await proxiesOf(api, vault);
      const { data } = await api.query.system.account(vault);
      console.log(`vault ${vault}: ${raoToTao(data.free)} TAO free, ${raoToTao(data.reserved)} TAO reserved, ${proxies.length} delegates`);
      for (const p of proxies) console.log(`- ${labelled(p.delegate, labels)} (${p.type}, delay ${p.delay})`);
      const stakes = await api.call.stakeInfoRuntimeApi?.getStakeInfoForColdkey?.(vault);
      if (!stakes) console.log('stake: not available on this chain');
      else {
        const held = stakes.filter((s) => s.stake.toString() !== '0');
        console.log(`stake: ${held.length} positions`);
        for (const s of held) console.log(`- netuid ${s.netuid} hotkey ${encodeAddress(s.hotkey, SS58)}: ${raoToTao(s.stake.toString())} alpha`);
      }
      const open = await pendingCalls(api, controller);
      console.log(`multisig ${controller}: ${open.length} pending`);
      for (const p of open) console.log(await pendingLine(api, p, labels));
    } finally {
      await api.disconnect();
    }
  },

  'config-check': async () => {
    const from = need('from');
    const signer = ss58Of(need('signer'));
    const signers = signersOpt();
    const threshold = thresholdOpt();
    const vault = ss58Of(need('proxy-for'));
    const mirror = mirrorOf(from);
    const controller = multisigAddress(signers, threshold);
    console.log([
      `net        ${opt.net}`,
      `trezor     ${from} (EVM address of the Trezor)`,
      `mirror     ${mirror} (ss58 mirror of trezor; pays the fees)`,
      `signer     ${signer} (pure proxy the Trezor controls)`,
      `signers    ${signers.join(', ')}`,
      `threshold  ${threshold} of ${signers.length}`,
      `multisig   ${controller} (from signers and threshold)`,
      `vault      ${vault} (pure proxy that holds the funds)`,
    ].join('\n'));
    const api = await connect(opt.net);
    try {
      const [ofSigner, ofVault] = [await proxiesOf(api, signer), await proxiesOf(api, vault)];
      const anyOfVault = ofVault.filter((p) => p.isAny);
      const found = (proxies) => `found: ${proxies.map(delegateLine).join(', ') || 'none'}`;
      const checks = [
        [signers.includes(signer), 'signer is one of signers', ''],
        [ofSigner.length === 1 && ofSigner[0].isAny && ofSigner[0].delegate === mirror, 'the only delegate of signer is the mirror (Any, delay 0)', found(ofSigner)],
        [anyOfVault.length === 1 && anyOfVault[0].delegate === controller, 'the only Any, delay 0 delegate of vault is the multisig', found(ofVault)],
      ];
      for (const [ok, what, detail] of checks) console.log(ok ? `OK    ${what}` : `FAIL  ${what} ${detail}`);
      if (ofVault.length > anyOfVault.length) console.log(`WARNING    vault has other delegates. ${found(ofVault)}`);
      for (const [label, account] of [['vault', vault], ['mirror', mirror], ['multisig', controller]]) {
        const { data } = await api.query.system.account(account);
        console.log(`${label.padEnd(10)} ${raoToTao(data.free)} TAO free, ${raoToTao(data.reserved)} TAO reserved`);
      }
      if (checks.some(([ok]) => !ok)) throw new Error('config-check FAILED');
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
if (opt.vault)
  for (const [flag, value] of Object.entries(vaultFlags(loadVault(opt.vault)))) {
    if (opt[flag] !== undefined && opt[flag] !== value) throw new Error(`--${flag} ${opt[flag]} conflicts with vault "${opt.vault}" (${flag} ${value})`);
    opt[flag] = value;
  }
opt.net ??= 'test';
opt.threshold ??= '2';
opt.index ??= '0';
if (opt.net !== 'test' && opt.net !== 'main') throw new Error('--net must be test or main');
await commands[cmd](rest);
process.exit(0);
