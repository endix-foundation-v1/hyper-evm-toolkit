import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import type { AppConfig } from '../types/config.js';
import { createVirtualHyperCoreRuntime, type VirtualHyperCoreRuntime } from '../app.js';
import { sleep } from '../utils/time.js';

function buildConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
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
      seed: 223,
    },
    mempool: {
      blockIntervalMs: 25,
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
      commandLogFile: './data/test-endix-flow-command-log.jsonl',
      stateSyncFile: './data/test-endix-flow-state-sync.json',
    },
    ...overrides,
  };
}

describe('Endix-style flow simulation scenarios', () => {
  let runtime: VirtualHyperCoreRuntime;

  beforeAll(async () => {
    runtime = createVirtualHyperCoreRuntime(buildConfig());
    await runtime.start();
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('simulates partial-fill execution and remainder expiry for market-style flow', async () => {
    const makerA = await request(runtime.app).post('/orders').send({
      id: 'mr-maker-100',
      symbol: 'ETH-USD',
      userId: 'maker-a',
      side: 'sell',
      kind: 'limit',
      quantity: 4,
      price: 100,
      timeInForce: 'GTC',
    });

    const makerB = await request(runtime.app).post('/orders').send({
      id: 'mr-maker-101',
      symbol: 'ETH-USD',
      userId: 'maker-b',
      side: 'sell',
      kind: 'limit',
      quantity: 2,
      price: 101,
      timeInForce: 'GTC',
    });

    expect(makerA.status).toBe(201);
    expect(makerB.status).toBe(201);

    const taker = await request(runtime.app)
      .post('/rpc/exchange')
      .send({
        action: {
          type: 'order',
          order: {
            id: 'mr-taker-market',
            symbol: 'ETH-USD',
            userId: 'mr-user',
            side: 'buy',
            kind: 'market',
            quantity: 10,
          },
        },
        awaitConfirmation: true,
      });

    expect(taker.status).toBe(200);
    expect(taker.body.status).toBe('confirmed');
    expect(taker.body.result.kind).toBe('submit_order');

    const submitOrderResult = taker.body.result.submitOrderResult;
    expect(submitOrderResult.order.status).toBe('EXPIRED');

    const totalMatchedQuantity = submitOrderResult.trades.reduce(
      (sum: number, trade: { quantity: number }) => sum + trade.quantity,
      0
    );
    expect(totalMatchedQuantity).toBe(6);
    expect(submitOrderResult.order.remainingQuantity).toBe(4);

    const trades = await request(runtime.app).post('/rpc/info').send({
      type: 'trades',
      symbol: 'ETH-USD',
      limit: 10,
    });

    expect(trades.status).toBe(200);
    const matchedTradeQuantity = trades.body.reduce(
      (sum: number, trade: { quantity: number }) => sum + trade.quantity,
      0
    );
    expect(matchedTradeQuantity).toBeGreaterThanOrEqual(6);
  });

  it('simulates open-order and cancel flow for SR-style unwind', async () => {
    const placeRestingOrder = await request(runtime.app)
      .post('/rpc/exchange')
      .send({
        action: {
          type: 'order',
          order: {
            id: 'sr-resting-order',
            symbol: 'ETH-USD',
            userId: 'sr-user',
            side: 'sell',
            kind: 'limit',
            quantity: 3,
            price: 109,
            timeInForce: 'GTC',
          },
        },
        awaitConfirmation: true,
      });

    expect(placeRestingOrder.status).toBe(200);
    expect(placeRestingOrder.body.result.submitOrderResult.order.status).toBe('NEW');

    const cancelRestingOrder = await request(runtime.app)
      .post('/rpc/exchange')
      .send({
        action: {
          type: 'cancel',
          cancel: {
            orderId: 'sr-resting-order',
            symbol: 'ETH-USD',
            userId: 'sr-user',
          },
        },
        awaitConfirmation: true,
      });

    expect(cancelRestingOrder.status).toBe(200);
    expect(cancelRestingOrder.body.result.kind).toBe('cancel_order');
    expect(cancelRestingOrder.body.result.cancelOrderResult.canceled).toBe(true);
  });
});

describe('Endix-style delayed confirmation edge case', () => {
  let runtime: VirtualHyperCoreRuntime;

  beforeAll(async () => {
    runtime = createVirtualHyperCoreRuntime(
      buildConfig({
        mempool: {
          blockIntervalMs: 25,
          maxTransactionsPerBlock: 200,
          defaultConfirmations: 12,
          confirmationProbabilityPerBlock: 0,
        },
        replay: {
          dataDir: './data',
          commandLogFile: './data/test-endix-flow-slow-confirm-command-log.jsonl',
          stateSyncFile: './data/test-endix-flow-slow-confirm-state-sync.json',
        },
      })
    );
    await runtime.start();
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('keeps transaction unconfirmed before delayed confirmation window closes', async () => {
    const submit = await request(runtime.app)
      .post('/rpc/exchange')
      .send({
        action: {
          type: 'order',
          order: {
            id: 'slow-confirm-order',
            symbol: 'ETH-USD',
            userId: 'slow-user',
            side: 'buy',
            kind: 'limit',
            quantity: 1,
            price: 90,
            timeInForce: 'GTC',
          },
        },
        confirmations: 12,
        awaitConfirmation: false,
      });

    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe('pending');

    let txStatus = await request(runtime.app).post('/rpc/info').send({
      type: 'transactionStatus',
      txId: submit.body.txId,
    });

    let attempts = 0;
    while (txStatus.body.status === 'pending' && attempts < 6) {
      await sleep(25);
      txStatus = await request(runtime.app).post('/rpc/info').send({
        type: 'transactionStatus',
        txId: submit.body.txId,
      });
      attempts += 1;
    }

    expect(txStatus.status).toBe(200);
    expect(['pending', 'included']).toContain(txStatus.body.status);
    expect(txStatus.body.confirmedBlockNumber).toBeUndefined();
    expect(txStatus.body.requiredConfirmations).toBe(12);
  });
});
