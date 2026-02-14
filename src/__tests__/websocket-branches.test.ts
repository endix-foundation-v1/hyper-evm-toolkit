import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import WebSocket from 'ws';

import type { AppConfig } from '../types/config.js';
import { createVirtualHyperCoreRuntime, type VirtualHyperCoreRuntime } from '../app.js';

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
    seed: 21,
  },
  mempool: {
    blockIntervalMs: 40,
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
    commandLogFile: './data/test-ws-branches-command-log.jsonl',
    stateSyncFile: './data/test-ws-branches-state-sync.json',
  },
};

function waitForMessage(
  socket: WebSocket,
  predicate: (payload: { channel: string; [key: string]: unknown }) => boolean,
  timeoutMs = 3_000
): Promise<{ channel: string; [key: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timeout waiting for websocket message'));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const payload = JSON.parse(raw.toString()) as { channel: string; [key: string]: unknown };
      if (predicate(payload)) {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(payload);
      }
    };

    socket.on('message', onMessage);
  });
}

describe('RealtimeGateway branch coverage', () => {
  let runtime: VirtualHyperCoreRuntime;
  let baseUrl: string;
  let wsUrl: string;

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

  it('handles ping, invalid json, and missing channel errors', async () => {
    const socket = new WebSocket(wsUrl);

    await new Promise<void>((resolve) => {
      socket.on('open', () => {
        resolve();
      });
    });

    socket.send('{not-json');
    const invalidJson = await waitForMessage(socket, (payload) => {
      return payload.channel === 'error' && (payload.data as { error?: string }).error === 'invalid_json';
    });
    expect(invalidJson.channel).toBe('error');

    socket.send(JSON.stringify({ method: 'subscribe' }));
    const missingChannel = await waitForMessage(socket, (payload) => {
      return payload.channel === 'error' && (payload.data as { error?: string }).error === 'missing_channel';
    });
    expect(missingChannel.channel).toBe('error');

    socket.send(JSON.stringify({ method: 'ping' }));
    const pong = await waitForMessage(socket, (payload) => payload.channel === 'pong');
    expect(pong.channel).toBe('pong');

    socket.close();
  });

  it('sends snapshots for orderbook and mempool subscriptions and handles unsubscribe', async () => {
    await request(baseUrl).post('/orders').send({
      id: 'ws-book-order',
      symbol: 'ETH-USD',
      userId: 'ws-user',
      side: 'sell',
      kind: 'limit',
      quantity: 3,
      price: 140,
      timeInForce: 'GTC',
    });

    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => {
      socket.on('open', () => {
        resolve();
      });
    });

    socket.send(JSON.stringify({ method: 'subscribe', channel: 'orderbook', symbol: 'ETH-USD' }));
    const orderbookSnapshot = await waitForMessage(socket, (payload) => {
      return payload.channel === 'orderbook' && payload.isSnapshot === true;
    });
    expect(orderbookSnapshot.channel).toBe('orderbook');

    socket.send(JSON.stringify({ method: 'subscribe', channel: 'orderbook', symbol: 'DOGE-USD' }));
    const dogeAck = await waitForMessage(socket, (payload) => {
      if (payload.channel !== 'subscriptionResponse') {
        return false;
      }
      const data = payload.data as { channel?: string; symbol?: string; method?: string };
      return data.channel === 'orderbook' && data.symbol === 'DOGE-USD' && data.method === 'subscribe';
    });
    expect(dogeAck.channel).toBe('subscriptionResponse');

    socket.send(JSON.stringify({ method: 'subscribe', channel: 'mempool' }));
    const mempoolSnapshot = await waitForMessage(socket, (payload) => {
      return payload.channel === 'mempool' && payload.isSnapshot === true;
    });
    expect(Array.isArray(mempoolSnapshot.data)).toBe(true);

    socket.send(JSON.stringify({ method: 'unsubscribe', channel: 'orderbook', symbol: 'ETH-USD' }));
    const unsubscribeAck = await waitForMessage(socket, (payload) => {
      if (payload.channel !== 'subscriptionResponse') {
        return false;
      }
      const data = payload.data as { method?: string; channel?: string };
      return data.method === 'unsubscribe' && data.channel === 'orderbook';
    });
    expect(unsubscribeAck.channel).toBe('subscriptionResponse');

    socket.close();
  });
});
