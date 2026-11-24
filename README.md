# trezor-vault

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

All commands take `--net test|main` (default `test`). Day-to-day use: see the handbook, [HANDBOOK.md](HANDBOOK.md) or [handbook.html](handbook.html).

| Command | Does |
| --- | --- |
| `node vault.mjs mirror <h160>` | ss58 mirror of an EVM address |
| `node vault.mjs address --signers a,b,c [--threshold 2]` | Multisig address |
| `node vault.mjs create-signer --from <h160> [--index 0]` | Spawn the pure proxy. Record the printed height, extIndex and index. |
| `node vault.mjs pending --signers a,b,c [--threshold 2]` | List open multisig calls |
| `node vault.mjs sign --from <h160> --signer <proxy> --signers a,b,c --transfer-to <ss58> --amount <tao>` | Open or approve a transfer |
| `node vault.mjs sign … --call <0xhex>` | Same, for any call |
| `node vault.mjs sign … --create-vault [--index 0]` | Spawn a pure proxy that the multisig controls. Record the printed height, extIndex and index. |
| `node vault.mjs sign … --proxy-for <ss58> …` | Run the call as that pure proxy (`Proxy.proxy` inside `as_multi`, same call hash as btcli) |
| `node vault.mjs sign … --proxy-for <ss58> --add-delegate <ss58>` | Add an Any, delay 0 delegate to the pure proxy |
| `node vault.mjs sign … --proxy-for <ss58> --remove-delegate <ss58>` | Remove one. Refuses to remove the last Any, delay 0 delegate. |
| `node vault.mjs delegates <ss58>` | Delegates (type, delay) and free balance of an account |
| `… --vault <name>` | Fill `--net --from --signer --signers --threshold --proxy-for` from `~/.trezor-vault/vaults.json` (or `TREZOR_VAULT_CONFIG`). A flag that differs from the config is an error. |
| `node vault.mjs config-check --vault <name>` | Print the config and check it against the chain. Exit code is not 0 on any `FAIL`. |
| `node vault.mjs approve --vault <name> [--hash <0x…>]` | Approve an open call. The call is read from the opener's extrinsic and shown in plain words. `--call <0xhex>` when the call data is not on chain. |
| `node vault.mjs info --vault <name>` | Vault balance, delegates, stake, and open calls |

Config file, one entry per vault:

```json
{ "1": { "net": "main", "trezor": "0x…", "signer": "5…", "signers": ["5…", "5…", "5…"], "threshold": 2, "vault": "5…" } }
```

`trezor` is `--from`, `signer` is `--signer`, `vault` is `--proxy-for`. `threshold` defaults to 2.

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
| `sign` and `approve` refuse `proxy.removeProxies` as a proxied account, and any set of `removeProxy` calls that leaves it no Any, delay 0 delegate | The funds of a pure proxy with no delegate are lost |
| `approve` prints every argument in full and labels every account id inside lists and structures | A cut argument could hide an address |
| The mined EVM tx must match the job: from, to, data, chain, value 0 | Built in |
