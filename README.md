# trezor-vault

**How to use it: [HANDBOOK.md](HANDBOOK.md)** (1 page, also as [handbook.html](handbook.html) to open offline).

Sign Bittensor multisig calls with a Trezor. The Trezor signs one EVM tx (via MetaMask) to the proxy precompile `0x…080b`. The precompile dispatches the call as a pure proxy that the Trezor controls.

```
Trezor 0x ──blake2_256("evm:" + h160)──► mirror ──sole delegate, Any──► pure proxy ──► multisig signatory
```

## Install

1. `git clone` this repo.
2. `git rev-parse HEAD` must equal the published commit hash.
3. `npm ci --ignore-scripts`. Never `npm install` or `npm update`: the lockfile is the reviewed dependency set.

Needs Node 24 or newer.

## Commands

Mainnet is the default (`--net test` for testnet).

One-time: `alias vault='node ~/trezor-vault/vault.mjs'` in `~/.bashrc`, and `~/.trezor-vault/vaults.json` (below).

### Daily use

| Command | Does |
| --- | --- |
| `vault approve N` | Approve the open call of vault N. The call is read from the chain and shown in plain words first. `--hash <0x…>` picks one of many. `--call <0xhex>` when the call data is not on chain. |
| `vault info N` | Vault balance, delegates, stake, and open calls |
| `vault check N` | Check the config against the chain. Exit code is not 0 on any `FAIL`. |

### Setup and low-level

| Command | Does |
| --- | --- |
| `vault mirror <h160>` | ss58 mirror of an EVM address |
| `vault address --signers a,b,c [--threshold 2]` | Multisig address |
| `vault create-signer --from <h160> [--index 0]` | Spawn the pure proxy. Record the printed height, extIndex and index. |
| `vault pending --signers a,b,c [--threshold 2]` | List open multisig calls |
| `vault delegates <ss58>` | Delegates (type, delay) and free balance of an account |
| `vault sign --from <h160> --signer <proxy> --signers a,b,c --transfer-to <ss58> --amount <tao>` | Open or approve a transfer |
| `vault sign … --call <0xhex>` | Same, for any call |
| `vault sign … --create-vault [--index 0]` | Spawn a pure proxy that the multisig controls. Record the printed height, extIndex and index. |
| `vault sign … --proxy-for <ss58> …` | Run the call as that pure proxy (`Proxy.proxy` inside `as_multi`, same call hash as btcli) |
| `vault sign … --proxy-for <ss58> --add-delegate <ss58>` | Add an Any, delay 0 delegate to the pure proxy |
| `vault sign … --proxy-for <ss58> --remove-delegate <ss58>` | Remove one. Refuses to remove the last Any, delay 0 delegate. |
| `… --vault N` | Fill `--net --from --signer --signers --threshold --proxy-for` from the config. A flag that differs from the config is an error. `--vault` always fills `--proxy-for`, so use the explicit flags for `sign --create-vault`. |

Config file, one entry per vault:

```json
{ "1": { "trezor": "0x…", "signer": "5…", "signers": ["5…", "5…", "5…"], "vault": "5…" } }
```

`trezor` is `--from`, `signer` is `--signer`, `vault` is `--proxy-for`. Optional: `threshold` (default 2), `net` (default `main`).

`create-signer`, `sign` and `approve` print a local URL. Open it in a browser with MetaMask, check the summary, then sign on the Trezor.

## Checks

| Check | Why |
| --- | --- |
| The call hash matches the one the other signatories see | It proves that all signers approve the same call |
| After `create-signer`, the proxy's delegate list (polkadot.js apps or an explorer) shows only the mirror | A second delegate could sign in the Trezor's place |
| `sign` refuses a proxy with any delegate other than the mirror | Built in |
| `sign --proxy-for` refuses unless the multisig is an Any, delay 0 delegate of the pure proxy. It warns on any extra delegate. | Every delegate can move the funds |
| `sign` and `approve` fail if the multisig call, a proxied call, or a batch item inside it returns an error | A failed inner call still reports `MultisigExecuted Ok` |
| `approve` runs the same checks as `sign`. It takes the call only if its hash equals the pending hash. | The Trezor signs blind: the terminal summary is the only check |
| `approve` prints `WARNING` when the call does not run as the configured vault, changes delegates, cancels a multisig call, moves a whole balance, or names an address with no label | These calls can move or lock the funds |
| `sign` and `approve` check every `proxy.proxy` at every depth of the call: the account that runs it must be an Any, delay 0 delegate of its `real` | A proxied call can hide inside a batch |
| `sign` and `approve` refuse `proxy.killPure`, `proxy.removeProxies` as a proxied account, and any set of `removeProxy` calls that leaves it no Any, delay 0 delegate | The funds of a pure proxy with no delegate are lost |
| `approve` prints every argument in full and labels every account id inside lists and structures | A cut argument could hide an address |
| The mined EVM tx must match the job: from, to, data, chain, value 0 | Built in |
