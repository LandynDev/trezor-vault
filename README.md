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

All commands take `--net test|main` (default `test`).

| Command | Does |
| --- | --- |
| `node vault.mjs mirror <h160>` | ss58 mirror of an EVM address |
| `node vault.mjs address --signers a,b,c [--threshold 2]` | Multisig address |
| `node vault.mjs create-signer --from <h160> [--index 0]` | Spawn the pure proxy. Record the printed height, extIndex and index. |
| `node vault.mjs pending --signers a,b,c [--threshold 2]` | List open multisig calls |
| `node vault.mjs sign --from <h160> --signer <proxy> --signers a,b,c --transfer-to <ss58> --amount <tao>` | Open or approve a transfer |
| `node vault.mjs sign … --call <0xhex>` | Same, for any call |

`create-signer` and `sign` print a local URL. Open it in a browser with MetaMask, check the summary, then sign on the Trezor.

## Checks

| Check | Why |
| --- | --- |
| The call hash matches the one the other signatories see | It proves that all signers approve the same call |
| After `create-signer`, the proxy's delegate list (polkadot.js apps or an explorer) shows only the mirror | A second delegate could sign in the Trezor's place |
| `sign` refuses a proxy with any delegate other than the mirror | Built in |
| The mined EVM tx must match the job: from, to, data, chain, value 0 | Built in |
