import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import type { AppConfig } from '../types/config.js';
import { createVirtualHyperCoreRuntime, type VirtualHyperCoreRuntime } from '../app.js';

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
      maxOrderBookDepth: 100,
    },
    rateLimit: {
      windowMs: 60_000,
      maxRequests: 10_000,
    },
    network: {
      baseLatencyMs: 0,
      jitterMs: 0,
      packetLossRate: 0,
      seed: 12,
    },
    mempool: {
      blockIntervalMs: 30,
      maxTransactionsPerBlock: 100,
      defaultConfirmations: 1,
      confirmationProbabilityPerBlock: 1,
    },
    bridge: {
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    replay: {
      dataDir: './data',
      commandLogFile: './data/test-api-branches-command-log.jsonl',
      stateSyncFile: './data/test-api-branches-state-sync.json',
    },
    ...overrides,
  };
}

describe('API branch coverage', () => {
  let runtime: VirtualHyperCoreRuntime;

  beforeAll(async () => {
    runtime = createVirtualHyperCoreRuntime(buildConfig());
    await runtime.start();
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('returns 400 for missing symbol query', async () => {
    const orderbook = await request(runtime.app).get('/orderbook');
    const depth = await request(runtime.app).get('/orderbook/depth');
    const trades = await request(runtime.app).get('/trades');

    expect(orderbook.status).toBe(400);
    expect(depth.status).toBe(400);
    expect(trades.status).toBe(400);
  });

  it('uses trace id header and numeric fallback parsing for query params', async () => {
    const withHeader = await request(runtime.app)
      .post('/orders')
      .set('x-trace-id', 'trace-from-header')
      .send({
        id: 'trace-id-order',
        symbol: 'ETH-USD',
        userId: 'trace-user',
        side: 'buy',
        kind: 'limit',
        quantity: 1,
        price: 101,
        timeInForce: 'GTC',
      });

    expect(withHeader.status).toBe(201);
    expect(withHeader.body.traceId).toBe('trace-from-header');

    const orderbook = await request(runtime.app)
      .get('/orderbook')
      .query({ symbol: 'ETH-USD', depth: 0 });
    expect(orderbook.status).toBe(200);

    const depth = await request(runtime.app)
      .get('/orderbook/depth')
      .query({ symbol: 'ETH-USD', levels: 'abc' });
    expect(depth.status).toBe(200);

    const trades = await request(runtime.app)
      .get('/trades')
      .query({ symbol: 'ETH-USD', limit: -1 });
    expect(trades.status).toBe(200);
  });

  it('returns 404 for unknown symbol reads', async () => {
    const orderbook = await request(runtime.app).get('/orderbook').query({ symbol: 'DOGE-USD' });
    const depth = await request(runtime.app).get('/orderbook/depth').query({ symbol: 'DOGE-USD' });
    const trades = await request(runtime.app).get('/trades').query({ symbol: 'DOGE-USD' });

    expect(orderbook.status).toBe(404);
    expect(depth.status).toBe(404);
    expect(trades.status).toBe(404);
  });

  it('handles order submit validation and cancel-not-found branches', async () => {
    const invalidSubmit = await request(runtime.app).post('/orders').send({});
    expect(invalidSubmit.status).toBe(400);

    const cancelUnknown = await request(runtime.app)
      .delete('/orders/missing-order')
      .query({ userId: 'u1', symbol: 'ETH-USD' });
    expect(cancelUnknown.status).toBe(404);
    expect(cancelUnknown.body.canceled).toBe(false);
  });

  it('covers rpc exchange validation paths', async () => {
    const invalidAction = await request(runtime.app).post('/rpc/exchange').send({ action: 'nope' });
    expect(invalidAction.status).toBe(400);

    const missingOrderPayload = await request(runtime.app).post('/rpc/exchange').send({
      action: { type: 'order' },
    });
    expect(missingOrderPayload.status).toBe(400);

    const missingCancelPayload = await request(runtime.app).post('/rpc/exchange').send({
      action: { type: 'cancel' },
    });
    expect(missingCancelPayload.status).toBe(400);

    const unsupported = await request(runtime.app).post('/rpc/exchange').send({
      action: { type: 'unknown' },
    });
    expect(unsupported.status).toBe(400);

    const awaitConfirm = await request(runtime.app).post('/rpc/exchange').send({
      action: {
        type: 'order',
        order: {
          id: 'await-confirm-order',
          symbol: 'ETH-USD',
          userId: 'u2',
          side: 'buy',
          kind: 'limit',
          quantity: 1,
          price: 99,
          timeInForce: 'GTC',
        },
      },
      awaitConfirmation: true,
    });
    expect(awaitConfirm.status).toBe(200);
    expect(awaitConfirm.body.status).toBe('confirmed');

    const cancelOrder = await request(runtime.app).post('/rpc/exchange').send({
      action: {
        type: 'order',
        order: {
          id: 'cancel-via-exchange',
          symbol: 'ETH-USD',
          userId: 'u3',
          side: 'sell',
          kind: 'limit',
          quantity: 1,
          price: 120,
          timeInForce: 'GTC',
        },
      },
      awaitConfirmation: true,
      gasPrice: 2_000_000_000,
      maxPriorityFeePerGas: 200_000_000,
    });
    expect(cancelOrder.status).toBe(200);

    const cancelConfirm = await request(runtime.app).post('/rpc/exchange').send({
      action: {
        type: 'cancel',
        cancel: {
          orderId: 'cancel-via-exchange',
          symbol: 'ETH-USD',
          userId: 'u3',
        },
      },
      awaitConfirmation: true,
      gasPrice: 2_000_000_000,
      maxPriorityFeePerGas: 200_000_000,
    });
    expect(cancelConfirm.status).toBe(200);
    expect(cancelConfirm.body.result.kind).toBe('cancel_order');
  });

  it('covers rpc info branches', async () => {
    const missingTx = await request(runtime.app).post('/rpc/info').send({ type: 'transactionStatus' });
    expect(missingTx.status).toBe(400);

    const unknownTx = await request(runtime.app)
      .post('/rpc/info')
      .send({ type: 'transactionStatus', txId: 'no-tx' });
    expect(unknownTx.status).toBe(404);

    const txList = await request(runtime.app).post('/rpc/info').send({ type: 'transactions' });
    expect(txList.status).toBe(200);
    expect(Array.isArray(txList.body)).toBe(true);

    const missingOrderbookSymbol = await request(runtime.app).post('/rpc/info').send({ type: 'orderbook' });
    const missingTradesSymbol = await request(runtime.app).post('/rpc/info').send({ type: 'trades' });
    expect(missingOrderbookSymbol.status).toBe(400);
    expect(missingTradesSymbol.status).toBe(400);

    const status = await request(runtime.app).post('/rpc/info').send({ type: 'status' });
    expect(status.status).toBe(200);
    expect(status.body).toHaveProperty('engine');

    const unsupported = await request(runtime.app).post('/rpc/info').send({ type: 'nope' });
    expect(unsupported.status).toBe(400);
  });

  it('returns 404 when bridge sync endpoint is disabled', async () => {
    const bridgeSync = await request(runtime.app).post('/bridge/sync').send({});

    expect(bridgeSync.status).toBe(404);
    expect(bridgeSync.body.error).toBe('bridge_not_enabled');
  });
});

describe('API network and rate limiting branches', () => {
  let lossyRuntime: VirtualHyperCoreRuntime;
  let limitedRuntime: VirtualHyperCoreRuntime;

  beforeAll(async () => {
    lossyRuntime = createVirtualHyperCoreRuntime(
      buildConfig({
        network: {
          baseLatencyMs: 0,
          jitterMs: 0,
          packetLossRate: 1,
          seed: 77,
        },
      })
    );
    await lossyRuntime.start();

    limitedRuntime = createVirtualHyperCoreRuntime(
      buildConfig({
        rateLimit: {
          windowMs: 60_000,
          maxRequests: 1,
        },
      })
    );
    await limitedRuntime.start();
  });

  afterAll(async () => {
    await lossyRuntime.stop();
    await limitedRuntime.stop();
  });

  it('returns 503 for dropped order/cancel in network simulator', async () => {
    const orderDropped = await request(lossyRuntime.app).post('/orders').send({
      id: 'dropped-order',
      symbol: 'ETH-USD',
      userId: 'u1',
      side: 'buy',
      kind: 'limit',
      quantity: 1,
      price: 100,
      timeInForce: 'GTC',
    });
    expect(orderDropped.status).toBe(503);

    const cancelDropped = await request(lossyRuntime.app).delete('/orders/dropped-order').query({ symbol: 'ETH-USD' });
    expect(cancelDropped.status).toBe(503);
  });

  it('returns 429 when request count exceeds rate limit window', async () => {
    const first = await request(limitedRuntime.app).get('/health');
    const second = await request(limitedRuntime.app).get('/health');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('rate_limited');
  });
});

describe('API bridge-sync branches', () => {
  let bridgeRuntime: VirtualHyperCoreRuntime;

  beforeAll(async () => {
    bridgeRuntime = createVirtualHyperCoreRuntime(
      buildConfig({
        bridge: {
          rpcUrl: 'http://127.0.0.1:1',
          chainId: 31337,
        },
        coreWriterActionBridge: {
          enabled: true,
          mode: 'manual',
          intervalMs: 25,
          coreWriterAddress: '0x3333333333333333333333333333333333333333',
          hyperCoreAddress: '0x9999999999999999999999999999999999999999',
          marketMap: {
            '1': 'ETH-USD',
          },
        },
      })
    );

    await bridgeRuntime.start();
  });

  afterAll(async () => {
    await bridgeRuntime.stop();
  });

  it('returns 500 when bridge sync throws', async () => {
    const bridgeSync = await request(bridgeRuntime.app).post('/bridge/sync').send({});

    expect(bridgeSync.status).toBe(500);
    expect(bridgeSync.body.error).toBe('bridge_sync_failed');
  });
});
