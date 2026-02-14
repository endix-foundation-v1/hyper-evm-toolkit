import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { MatchingEngine } from '../engine/matching-engine.js';
import { CommandLog } from '../logging/command-log.js';
import { MetricsRegistry } from '../metrics/registry.js';

const TEST_LOG_PATH = './data/test-command-log.jsonl';

function createEngine(commandLogPath: string): MatchingEngine {
  return new MatchingEngine({
    config: {
      symbols: ['ETH-USD'],
      tickSize: 1,
      lotSize: 1,
      minOrderQuantity: 1,
      maxOrderBookDepth: 50,
    },
    commandLog: new CommandLog(commandLogPath),
    metrics: new MetricsRegistry(),
    randomSeed: 777,
  });
}

describe('MatchingEngine', () => {
  it('replays command logs deterministically', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const engine = createEngine(TEST_LOG_PATH);
    const maker = await engine.submitOrder({
      id: 'maker-1',
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 10,
      price: 120,
      timeInForce: 'GTC',
    });

    expect(maker.order.status).toBe('NEW');

    const taker = await engine.submitOrder({
      id: 'taker-1',
      symbol: 'ETH-USD',
      userId: 'taker-user',
      side: 'buy',
      kind: 'market',
      quantity: 4,
      timeInForce: 'IOC',
    });

    expect(taker.order.status).toBe('FILLED');

    await engine.cancelOrder('maker-1', 'maker-user', 'ETH-USD');
    const snapshotAfterCommands = engine.getSnapshot('ETH-USD', 10);

    const replayEngine = createEngine(TEST_LOG_PATH);
    const replayResult = await replayEngine.replayFromCommandLog();
    expect(replayResult.appliedCommands).toBe(3);

    const snapshotAfterReplay = replayEngine.getSnapshot('ETH-USD', 10);
    expect(snapshotAfterReplay.bids).toEqual(snapshotAfterCommands.bids);
    expect(snapshotAfterReplay.asks).toEqual(snapshotAfterCommands.asks);
  });

  it('returns sane stats after activity', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const engine = createEngine(TEST_LOG_PATH);
    await engine.submitOrder({
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 3,
      price: 100,
      timeInForce: 'GTC',
    });

    await engine.submitOrder({
      symbol: 'ETH-USD',
      userId: 'buyer-user',
      side: 'buy',
      kind: 'market',
      quantity: 2,
      timeInForce: 'IOC',
    });

    const stats = engine.getStats();
    expect(stats.totalOrdersSubmitted).toBe(2);
    expect(stats.totalTradesExecuted).toBe(1);
    expect(stats.activeOrders).toBeGreaterThanOrEqual(0);
  });
});
