# trezor-vault handbook

How to run a proxied 2-of-3 vault on Bittensor with a Trezor and btcli 11.3.0.

## Names

| Name | Meaning |
| --- | --- |
| vault-N | Pure proxy that holds the funds. Its only delegate is multisig-N (Any, delay 0). |
| multisig-N | 2-of-3 multisig: the btcli signer, the Trezor signer, the backup signer. |
| Trezor signer | Pure proxy that the Trezor controls. It is one of the 3 signers. |
| `<btcli wallet>` | btcli wallet of the btcli signer. |
| btcli device | Computer with btcli and the btcli wallet. |
| Trezor device | Computer with this repo, a browser, MetaMask, and the Trezor. |

One person opens a call on the btcli device. The Trezor approves it. The call then runs as vault-N.

This handbook assumes that the Trezor signer, multisig-N and vault-N exist. To create them, see `README.md` (`create-signer`, `sign --create-vault`).

## 1. One-time setup

### Trezor device

1. Clone the repo: `git clone <repo url> ~/trezor-vault && cd ~/trezor-vault`
2. Check the commit: `git rev-parse HEAD` must equal the published commit hash.
3. Install: `npm ci --ignore-scripts`. Never run `npm install` or `npm update`.
4. Create the config file `~/.trezor-vault/vaults.json`:

```json
{
  "N": {
    "net": "main",
    "trezor": "<0x address of the Trezor>",
    "signer": "<Trezor signer address>",
    "signers": ["<btcli signer address>", "<Trezor signer address>", "<backup signer address>"],
    "threshold": 2,
    "vault": "<vault-N address>"
  }
}
```

5. Add the alias to `~/.bashrc` or `~/.zshrc`, then open a new terminal:

```
alias vault='node ~/trezor-vault/vault.mjs'
```

6. Check the config against the chain:

```
vault config-check --vault N
```

Every line must start with `OK`. Stop if a line starts with `FAIL`.

| Field | Meaning |
| --- | --- |
| net | `main` or `test` |
| trezor | EVM address of the Trezor account in MetaMask |
| signer | The Trezor signer (pure proxy) |
| signers | All 3 signer addresses. All devices must use the same 3. |
| threshold | Approvals needed. Default 2. |
| vault | vault-N |

### btcli device

1. Save the multisig:

```
btcli multisig add multisig-N --threshold 2 --signatories <btcli wallet>,<Trezor signer address>,<backup signer address>
```

The printed `multisig_address` must equal the `multisig` line of `vault config-check`.

2. Save the vault. `<h>` and `<e>` are the `height` and `extIndex` that were printed when the vault was created:

```
btcli proxy book add --name vault-N --address <vault-N address> --spawner multisig-N --proxy-type Any --delay 0 --index 0 --height <h> --ext-index <e>
```

## 2. Core loop

Every action uses the same 3 steps.

| Step | Device | Do |
| --- | --- | --- |
| 1. Open | btcli device | Run the btcli command from the recipe table. Note the printed `multisig call hash`. |
| 2. Approve | Trezor device | Run `vault approve --vault N`. Read the summary. Open the printed URL. Sign on the Trezor. |
| 3. Check | Trezor device | The output must show `MultisigExecuted` with `"result":"Ok"` and no `Error`. Then run `vault info --vault N`. |

Every btcli command that opens a call ends with the same flags:

```
-w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney
```

### What to check before you sign

The Trezor does not show the call. The terminal summary is the only check.

| Line | Must be |
| --- | --- |
| `call hash` | Equal to the `multisig call hash` that btcli printed |
| `call` | `proxy.proxy(real=… (vault), …)`, then the action you expect |
| Amounts | The amount you expect. Amounts show in TAO or alpha, and in rao. |
| Addresses | Correct in every character. A known address has a label: `(vault)`, `(multisig)`, `(signer N)`, `(your Trezor signer)`. |
| `WARNING` | Read every one. An address with no label always gives a `WARNING`. Stop if you do not expect a warning. |
| `action` | `EXECUTE` for the second approval of a 2-of-3 |

If more than one call is open, `vault approve --vault N` lists them. Run it again with the hash:

```
vault approve --vault N --hash <0x call hash>
```

## 3. Recipes

Step 1 commands for the btcli device. Then do steps 2 and 3 of the core loop.

| Goal | Command |
| --- | --- |
| Pay TAO | `btcli wallet transfer --dest <address> --amount <tao> -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney` |
| Check balance, stake, open calls | `vault info --vault N` (Trezor device, no signing) |
| List open calls on the btcli device | `btcli multisig pending -w multisig-N -n finney` |
| Stake add | `btcli stake add --hotkey <hotkey address> --netuid <netuid> --amount <tao> -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney` |
| Stake remove | `btcli stake remove --hotkey <hotkey address> --netuid <netuid> --amount <alpha> -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney` |
| Stake move | `btcli stake move --origin-hotkey <hotkey address> --dest-hotkey <hotkey address> --origin-netuid <netuid> --dest-netuid <netuid> --amount <alpha> -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney` |
| Transfer stake to another coldkey | `btcli stake transfer --dest <coldkey address> --hotkey <hotkey address> --origin-netuid <netuid> --dest-netuid <netuid> --amount <alpha> -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney` |
| Cancel an open call | See "Cancel an open call" |
| Rotate a vault delegate | See "Rotate a vault delegate" |

Full example, pay 1.5 TAO:

```
btcli wallet transfer --dest <address> --amount 1.5 -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney
vault approve --vault N
vault info --vault N
```

Amounts: `<tao>` is in TAO. `<alpha>` is in the alpha of the origin subnet.

### Stake calls have a price limit

btcli puts a price limit in every stake call when it opens the call. Approve soon after the call is opened. If the price moves past the limit, the call fails with `SlippageTooHigh`. The tool reports the failure and nothing moves. Open the call again.

### Cancel an open call

Only the signer that opened the call can cancel it. Get the hash and the `opened at <height>-<index>` values from `vault info --vault N`. The btcli wallet signs this command directly:

```
btcli call Multisig.cancel_as_multi --args '{"threshold":2,"other_signatories":["<signer address A>","<signer address B>"],"timepoint":{"height":<height>,"index":<index>},"call_hash":"<0x call hash>"}' -w <btcli wallet> -n finney
```

`other_signatories` are the 2 signers that are not the btcli wallet. If btcli reports `SignatoriesOutOfOrder`, swap the 2 addresses and run the command again.

### Rotate a vault delegate

Always add the new delegate first. Remove the old delegate second.

1. Open: `btcli proxy add --delegate <new delegate address> --proxy-type Any --delay 0 -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney`
2. Approve: `vault approve --vault N`. A `WARNING` for `proxy.addProxy` is correct here.
3. Check: `vault info --vault N` shows both delegates.
4. Open: `btcli proxy remove --delegate <old delegate address> --proxy-type Any --delay 0 -w multisig-N --signatory <btcli wallet> --proxy-for vault-N --no-mev-shield -n finney`
5. Approve and check again.

Every Any delegate can move all funds of the vault. The tool refuses to remove the last Any, delay 0 delegate, because the funds would be lost. If the new delegate is a new multisig, the old multisig must do step 4 before you update `vaults.json` and the btcli books.

## 4. Troubleshooting

| Message | Cause | Fix |
| --- | --- | --- |
| `no pending calls` | No call is open, or it was already executed | Run `vault info --vault N` |
| `more than one pending call` | Many calls are open | Run again with `--hash <0x call hash>` |
| `the call data of … is not on chain` | The call was opened with the MEV shield or with a hash only | Cancel it. Open it again with `--no-mev-shield`. Or pass `--call <0xhex>` (btcli prints `multisig call data`). |
| `--call has hash …; the pending call is …` | The call hex is not the open call | Use the `multisig call data` that btcli printed |
| `… already approved …` | The Trezor signer approved this call before | Another signer must approve |
| `approved, NOT executed` | The threshold is not reached | Another signer must approve |
| `proxied call FAILED: …SlippageTooHigh` | The price moved past the limit of a stake call | Nothing moved. Open the call again and approve sooner. |
| `proxied call FAILED: …` | The call ran and failed (for example, not enough balance) | Nothing moved. Read the error name, fix the cause, open the call again. |
| `… is not an Any, delay 0 delegate of …` | The multisig does not control that account | Check `signers`, `threshold` and `vault` in `vaults.json` |
| `… must have exactly one proxy` | The Trezor signer has a wrong delegate set | Stop. Do not sign. Check the Trezor signer on an explorer. |
| `refusing: … is the last Any, delay 0 delegate` | The call would lock the vault forever | Cancel the call |
| `conflicts with vault "N"` | A flag is different from `vaults.json` | Remove the flag, or correct the config |
| `cannot read vault config` / `no vault "N"` | The config file or the name is missing | Create `~/.trezor-vault/vaults.json` (section 1) |
| `config-check FAILED` | The chain does not match the config | Stop. Compare each printed address with your records. |
| `evm tx reverted` | The EVM transaction failed | Check that the `mirror` line of `vault config-check` shows TAO for fees. Then try again. |
