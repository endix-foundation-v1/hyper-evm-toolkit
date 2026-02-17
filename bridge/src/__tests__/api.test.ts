import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import type { AppConfig } from '../types/config.js';
import { createVirtualHyperCoreRuntime, type VirtualHyperCoreRuntime } from '../app.js';
import { sleep } from '../utils/time.js';

let runtime: VirtualHyperCoreRuntime;

const testConfig: AppConfig = {
  port: 0,
  wsPath: '/ws',
  nodeEnv: 'test',
  engine: {
    symbols: ['ETH-USD'],
    tickSize: 1,
    lotSize: 1,
    minOrderQuantity: 1,
    maxOrderBookDepth: 200,
  },
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10_000,
  },
  network: {
    baseLatencyMs: 0,
    jitterMs: 0,
    packetLossRate: 0,
    seed: 44,
  },
  mempool: {
    blockIntervalMs: 40,
    maxTransactionsPerBlock: 200,
    defaultConfirmations: 1,
    confirmationProbabilityPerBlock: 1,
  },
  bridge: {
    rpcUrl: 'http://127.0.0.1:8545',
    chainId: 31337,
  },
  replay: {
    dataDir: './data',
    commandLogFile: './data/test-api-command-log.jsonl',
    stateSyncFile: './data/test-api-state-sync.json',
  },
};

describe('Virtual HyperCore API', () => {
  beforeAll(async () => {
    runtime = createVirtualHyperCoreRuntime(testConfig);
    await runtime.start();
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('accepts limit orders and exposes order book depth', async () => {
    const create = await request(runtime.app).post('/orders').send({
      id: 'api-maker-order',
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 8,
      price: 100,
      timeInForce: 'GTC',
    });

    expect(create.status).toBe(201);
    expect(create.body.order.status).toBe('NEW');

    const depth = await request(runtime.app).get('/orderbook/depth').query({ symbol: 'ETH-USD', levels: 5 });
    expect(depth.status).toBe(200);
    expect(depth.body.asks[0].price).toBe(100);
    expect(depth.body.asks[0].quantity).toBe(8);
  });

  it('cancels existing orders via REST endpoint', async () => {
    const cancel = await request(runtime.app)
      .delete('/orders/api-maker-order')
      .query({ userId: 'maker-user', symbol: 'ETH-USD' });

    expect(cancel.status).toBe(200);
    expect(cancel.body.canceled).toBe(true);
  });

  it('submits virtual exchange transactions and confirms them', async () => {
    const submit = await request(runtime.app)
      .post('/rpc/exchange')
      .send({
        action: {
          type: 'order',
          order: {
            id: 'vm-order-1',
            symbol: 'ETH-USD',
            userId: 'vm-user',
            side: 'buy',
            kind: 'limit',
            quantity: 5,
            price: 99,
            timeInForce: 'GTC',
          },
        },
        gasPrice: '1000000000',
        maxPriorityFeePerGas: '100000000',
      });

    expect(submit.status).toBe(202);
    expect(submit.body.txId).toBeTypeOf('string');

    await sleep(160);

    const txStatus = await request(runtime.app).post('/rpc/info').send({
      type: 'transactionStatus',
      txId: submit.body.txId,
    });

    expect(txStatus.status).toBe(200);
    expect(['pending', 'included', 'confirmed']).toContain(txStatus.body.status);
  });

  it('exposes metrics endpoint', async () => {
    const metrics = await request(runtime.app).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('virtual_hypercore_orders_total');
  });
});
