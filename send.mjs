import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, getAddress } from 'ethers';
import { NETWORKS } from './chain.mjs';

const PAGE = readFileSync(new URL('./send.html', import.meta.url), 'utf8');

const provider = (net) => new JsonRpcProvider(NETWORKS[net].rpc, NETWORKS[net].chainId, { staticNetwork: true });

// Serves a one-shot local page; MetaMask (with the Trezor) signs, the page posts back the tx hash.
// The mined tx must be exactly the job: a forged hash posted to /tx is rejected here.
const confirmMined = async (net, hash, job) => {
  const rpc = provider(net);
  const receipt = await rpc.waitForTransaction(hash);
  const tx = await rpc.getTransaction(hash);
  const same = getAddress(tx.from) === getAddress(job.from) && tx.to?.toLowerCase() === job.to.toLowerCase() && tx.data.toLowerCase() === job.data.toLowerCase() && Number(tx.chainId) === job.chainId && tx.value === 0n;
  if (!same) throw new Error(`tx ${hash} does not match the job (from/to/data/chain/value)`);
  if (receipt.status !== 1) throw new Error(`evm tx reverted: ${hash}`);
  return receipt;
};

export const send = ({ net, from, to, data, summary }) =>
  new Promise((resolve, reject) => {
    const token = randomBytes(16).toString('hex');
    const job = { chainId: NETWORKS[net].chainId, from: getAddress(from), to, data, value: '0x0', summary };
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === `/${token}`) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(PAGE.replace('/*JOB*/null', () => JSON.stringify({ ...job, token }).replace(/</g, '\\u003c')));
      }
      if (req.method === 'POST' && req.url === `/tx/${token}`) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.end('ok');
          server.close();
          try {
            const { hash } = JSON.parse(body);
            console.log(`evm tx ${hash}`);
            resolve(await confirmMined(net, hash, job));
          } catch (e) {
            reject(e);
          }
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => console.log(`open http://127.0.0.1:${server.address().port}/${token} in Chromium`));
  });
