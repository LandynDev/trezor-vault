#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { encodeAddress } from '@polkadot/util-crypto';
import {
  PROXY_PRECOMPILE, PROXY_TYPE_ANY, SS58, buildAsMulti, connect, createPureProxyData, describeCall,
  findPureCreated, mirrorOf, multisigAddress, proxyCallData, raoToTao, ss58Of, taoToRao,
} from './chain.mjs';
import { send } from './send.mjs';

const USAGE = `usage: node vault.mjs <command> [--net test|main]
  mirror <h160>                                         ss58 mirror of an EVM address
  address --signers a,b,c [--threshold 2]               multisig (vault) address
  create-signer --from <h160> [--index 0]               spawn the Trezor's pure proxy (trezor-signer)
  pending --signers a,b,c [--threshold 2]               list open vault calls
  sign --from <h160> --signer <trezor-signer> --signers a,b,c [--threshold 2]
       (--transfer-to <ss58> --amount <tao> | --call <0xhex>)
                                                        open/approve a vault call through the Trezor`;

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    net: { type: 'string', default: 'test' }, from: { type: 'string' },
    index: { type: 'string', default: '0' }, signers: { type: 'string' }, threshold: { type: 'string', default: '2' },
    signer: { type: 'string' }, 'transfer-to': { type: 'string' }, amount: { type: 'string' }, call: { type: 'string' },
  },
});

const need = (name) => {
  if (!opt[name]) throw new Error(`--${name} is required\n\n${USAGE}`);
  return opt[name];
};
const signersOpt = () => need('signers').split(',').map((s) => ss58Of(s.trim()));
const thresholdOpt = () => Number(opt.threshold);

const assertAnyDelegate = async (api, real, delegate) => {
  const [proxies] = await api.query.proxy.proxies(real);
  const [p] = proxies;
  // Exactly one delegate: any extra delegate could vote in the Trezor's seat.
  const ok = proxies.length === 1 && encodeAddress(p.delegate, SS58) === delegate && p.proxyType.index === PROXY_TYPE_ANY && p.delay.isZero();
  if (!ok) throw new Error(`${real} must have exactly one proxy: ${delegate} (Any, delay 0). Found: ${JSON.stringify(proxies.toHuman())}`);
};

const reportMultisig = async (api, blockNumber, vault) => {
  const events = await (await api.at(await api.rpc.chain.getBlockHash(blockNumber))).query.system.events();
  const mine = events.filter(({ event }) => event.section === 'multisig' && encodeAddress(event.data.multisig, SS58) === vault);
  if (!mine.length) throw new Error(`no multisig event for ${vault} in block ${blockNumber}`);
  for (const { event } of mine) console.log(`${event.method} ${JSON.stringify(event.data.toHuman())}`);
  const failed = mine.find(({ event }) => api.events.multisig.MultisigExecuted.is(event) && event.data.result.isErr);
  if (failed) throw new Error(`vault call executed but FAILED: ${failed.event.data.result.toString()}`);
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
      const entries = await api.query.multisig.multisigs.entries(vault);
      console.log(`vault ${vault}: ${entries.length} pending`);
      for (const [key, ms] of entries) {
        const m = ms.unwrap();
        console.log(`- hash ${key.args[1].toHex()} opened at ${m.when.height}-${m.when.index} by ${encodeAddress(m.depositor, SS58)}, ${m.approvals.length} approvals`);
      }
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
    const api = await connect(opt.net);
    try {
      await assertAnyDelegate(api, signer, mirrorOf(from));
      const call = opt.call
        ? api.tx(api.createType('Call', opt.call))
        : api.tx.balances.transferKeepAlive(ss58Of(need('transfer-to')), taoToRao(need('amount')));
      const { vault, callHash, pending, asMulti } = await buildAsMulti(api, { signers, threshold, signer, call });
      const approvals = pending ? pending.approvals.length : 0;
      const action = approvals + 1 >= threshold ? 'EXECUTE' : pending ? 'APPROVE' : 'OPEN';
      if (!pending) console.warn('warning: no open call found; the Trezor signer will open it and pay the deposit');
      const summary = [
        `vault      ${vault} (${threshold}-of-${signers.length})`,
        `signers    ${signers.join(', ')}`,
        `signing as ${signer} (trezor-signer)`,
        `action     ${action} (${approvals}/${threshold} approvals before this)`,
        `timepoint  ${pending ? `${pending.when.height}-${pending.when.index}` : 'none (opens new call)'}`,
        `call hash  ${callHash}   <- must match the other signer`,
        `call       ${describeCall(call)}`,
        opt.call ? '' : `amount     ${raoToTao(taoToRao(opt.amount))} TAO`,
      ].join('\n');
      console.log(summary);
      const receipt = await send({ net: opt.net, from, to: PROXY_PRECOMPILE, data: proxyCallData(signer, asMulti), summary });
      await reportMultisig(api, receipt.blockNumber, vault);
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
