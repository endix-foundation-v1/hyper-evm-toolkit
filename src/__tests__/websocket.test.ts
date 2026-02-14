import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import WebSocket from 'ws';

import type { AppConfig } from '../types/config.js';
import { createVirtualHyperCoreRuntime, type VirtualHyperCoreRuntime } from '../app.js';

let runtime: VirtualHyperCoreRuntime;
let baseUrl: string;
let wsUrl: string;

const config: AppConfig = {
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
    seed: 91,
  },
  mempool: {
    blockIntervalMs: 50,
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
    commandLogFile: './data/test-ws-command-log.jsonl',
    stateSyncFile: './data/test-ws-state-sync.json',
  },
};

describe('RealtimeGateway', () => {
  beforeAll(async () => {
    runtime = createVirtualHyperCoreRuntime(config);
    await runtime.start();

    const address = runtime.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('pushes trade updates over websocket subscriptions', async () => {
    const socket = new WebSocket(wsUrl);

    const tradeMessagePromise = new Promise<{ channel: string; data: { symbol: string } }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timeout waiting for websocket trade message'));
      }, 3_000);

      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as { channel: string; data?: { symbol: string } };
        if (payload.channel === 'trades') {
          clearTimeout(timeout);
          resolve(payload as { channel: string; data: { symbol: string } });
        }
      });
    });

    await new Promise<void>((resolve) => {
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            method: 'subscribe',
            channel: 'trades',
            symbol: 'ETH-USD',
          })
        );
        resolve();
      });
    });

    await request(baseUrl).post('/orders').send({
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 4,
      price: 200,
      timeInForce: 'GTC',
    });

    await request(baseUrl).post('/orders').send({
      symbol: 'ETH-USD',
      userId: 'buyer-user',
      side: 'buy',
      kind: 'market',
      quantity: 2,
      timeInForce: 'IOC',
    });

    const tradeMessage = await tradeMessagePromise;
    expect(tradeMessage.channel).toBe('trades');
    expect(tradeMessage.data.symbol).toBe('ETH-USD');

    socket.close();
  });
});
