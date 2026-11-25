# trezor-vault cheat sheet

N = vault number (1, 2, 3). Mainnet is the default.

## Every action = 2 steps

| Step | Where | Type |
| --- | --- | --- |
| 1. Open | btcli computer | `v1 <btcli command>` (see the table below) |
| 2. Approve | Trezor computer | `vault approve 1`, read the summary, sign on the Trezor |

## Trezor computer commands

| Do | Type |
| --- | --- |
| Approve the open call | `vault approve N` |
| Balance, stake, open calls | `vault info N` |
| Check the setup | `vault check N` (3 lines must say `OK`) |
| Approve one of many open calls | `vault approve N --hash <0x…>` |

## btcli computer commands (step 1)

| Do | Type |
| --- | --- |
| Pay TAO | `v1 wallet transfer --dest <address> --amount <tao>` |
| Stake add | `v1 stake add --hotkey <hotkey> --netuid <netuid> --amount <tao>` |
| Stake remove | `v1 stake remove --hotkey <hotkey> --netuid <netuid> --amount <alpha>` |
| Unstake all from one hotkey | `v1 stake remove --hotkey <hotkey> --netuid <netuid> --all` |
| Unstake everything | `v1 stake unstake-all --all-hotkeys` |
| Stake move | `v1 stake move --origin-hotkey <hotkey> --dest-hotkey <hotkey> --origin-netuid <netuid> --dest-netuid <netuid> --amount <alpha>` |
| Stake transfer to another coldkey | `v1 stake transfer --dest <coldkey> --hotkey <hotkey> --origin-netuid <netuid> --dest-netuid <netuid> --amount <alpha>` |
| List open calls | `btcli multisig pending -w multisig-1 -n finney` |

Use `v2` or `v3` for the other vaults. For a stake call, approve within a few minutes. If the price moves, the call fails, nothing moves, and you open it again. For stake transfer, keep both netuids the same: a move to another subnet has no price limit.

## Before you sign: check the summary

| Line | Must be |
| --- | --- |
| `call hash` | Same as the hash that btcli printed |
| `call` | `proxy.proxy(real=… (vault), …)`, then your action |
| Amounts and addresses | What you expect, every character |
| `WARNING` | Stop if you did not expect it. Any address with no label gives one. |
| `action` | `EXECUTE` |

After you sign, the output must show `"result":"Ok"`.

## One-time setup

### Trezor computer

1. `cd ~/trezor-vault && git pull`. `git rev-parse HEAD` must equal the published hash.
2. `npm ci --ignore-scripts`. Never `npm install` or `npm update`.
3. `~/.trezor-vault/vaults.json`, one entry per vault:

```json
{
  "1": {
    "trezor": "<Trezor 0x address>",
    "signer": "<trezor signer 1>",
    "signers": ["<btcli signer 1>", "<trezor signer 1>", "<backup signer 1>"],
    "vault": "<vault-1>"
  }
}
```

4. Add to `~/.bashrc`: `alias vault='node ~/trezor-vault/vault.mjs'`. Open a new terminal.
5. `vault check 1`, `vault check 2`, `vault check 3`.

### btcli computer

1. Save each multisig: `btcli multisig add multisig-1 --threshold 2 --signatories <btcli wallet>,<trezor signer 1>,<backup signer 1>`
2. Save each vault: `btcli proxy book add --name vault-1 --address <vault-1> --spawner multisig-1 --proxy-type Any --delay 0 --index 0 --height <h> --ext-index <e>` (`<h>` and `<e>` were printed when you created vault-1).
3. Add one line per vault to `~/.bashrc`, then open a new terminal:

```
v1() { btcli "$@" -w multisig-1 --signatory <btcli wallet 1> --proxy-for vault-1 --no-mev-shield -n finney; }
```

`--no-mev-shield` is required. Without it, the Trezor computer cannot read the call.

## Rare tasks

### Cancel an open call (btcli computer)

Get `<height>-<index>` and the hash from `vault info N`.

```
btcli call Multisig.cancel_as_multi --args '{"threshold":2,"other_signatories":["<trezor signer 1>","<backup signer 1>"],"timepoint":{"height":<height>,"index":<index>},"call_hash":"<0x hash>"}' -w <btcli wallet 1> -n finney
```

If btcli says `SignatoriesOutOfOrder`, swap the 2 addresses.

### Replace a vault delegate

Add the new one first. Remove the old one second. The tool refuses to remove the last delegate.

1. btcli computer: `v1 proxy add --delegate <new> --proxy-type Any --delay 0`. Trezor computer: `vault approve 1`. The `WARNING` is expected.
2. btcli computer: `v1 proxy remove --delegate <old> --proxy-type Any --delay 0`. Trezor computer: `vault approve 1`.
3. Trezor computer: `vault check 1` shows 3 `OK`.

## Errors

| Message | Fix |
| --- | --- |
| `no pending calls` | Nothing is open. Check `vault info N`. |
| `more than one pending call` | `vault approve N --hash <0x…>` |
| `call data … not found on chain` | btcli opened it without `--no-mev-shield`. Cancel it and open it again with `v1`. |
| `approved, NOT executed` | One more signer must approve |
| `inner call FAILED: …SlippageTooHigh` | Price moved. Nothing moved. Open it again and approve faster. |
| `inner call FAILED: …` | The call failed, so nothing moved. Read the error name. |
| `utility.BatchInterrupted` / `ItemFailed` | Part of a batch ran. Check `vault info N`. |
| `must have exactly one proxy`, `is not an Any, delay 0 delegate`, `check FAILED` | Stop. Do not sign. Compare the addresses with your papers. |
| `evm tx reverted` | The mirror needs TAO for fees (`vault check N` shows it) |
