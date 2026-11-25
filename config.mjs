import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ss58Of } from './chain.mjs';

export const configPath = () => process.env.TREZOR_VAULT_CONFIG || join(homedir(), '.trezor-vault', 'vaults.json');

const validVault = (v, where) => {
  const fail = (why) => {
    throw new Error(`${where}: ${why}`);
  };
  const address = (field, value) => {
    try {
      return ss58Of(value);
    } catch (e) {
      fail(`${field} is not a valid ss58 address: ${e.message}`);
    }
  };
  if (!v || typeof v !== 'object') fail('must be an object');
  if (v.net !== undefined && v.net !== 'test' && v.net !== 'main') fail('net must be test or main');
  if (!/^0x[0-9a-fA-F]{40}$/.test(v.trezor)) fail('trezor must be a 0x address with 40 hex digits');
  if (!Array.isArray(v.signers) || v.signers.length < 2) fail('signers must list at least 2 addresses');
  v.signers.forEach((s, i) => address(`signers[${i}]`, s));
  if (new Set(v.signers).size !== v.signers.length) fail('signers must be different addresses');
  address('signer', v.signer);
  address('vault', v.vault);
  if (!v.signers.includes(v.signer)) fail('signer is not in signers');
  const threshold = v.threshold ?? 2;
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > v.signers.length) fail(`threshold must be an integer from 2 to ${v.signers.length}`);
  return { ...v, net: v.net ?? 'main', threshold };
};

export const loadVault = (name) => {
  const path = configPath();
  let vaults;
  try {
    vaults = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read vault config ${path}: ${e.message}`);
  }
  if (!vaults || typeof vaults !== 'object' || Array.isArray(vaults)) throw new Error(`vault config ${path} must be a JSON object of vaults`);
  if (!Object.hasOwn(vaults, name)) throw new Error(`no vault "${name}" in ${path} (found: ${Object.keys(vaults).join(', ') || 'none'})`);
  return validVault(vaults[name], `vault "${name}" in ${path}`);
};

// The flags that --vault fills.
export const vaultFlags = (v) => ({
  net: v.net, from: v.trezor, signer: v.signer, signers: v.signers.join(','), threshold: String(v.threshold), 'proxy-for': v.vault,
});
