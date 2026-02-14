import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkSimulator } from '../network/network-simulator.js';
import { MockP2PBus } from '../network/p2p-bus.js';
import { StateSynchronizer } from '../sync/state-synchronizer.js';
import { MetricsRegistry } from '../metrics/registry.js';
import { CommandLog } from '../logging/command-log.js';
import { Logger } from '../logging/logger.js';
import type { MatchingEngine } from '../engine/matching-engine.js';
import type { AnvilBridge } from '../bridge/anvil-bridge.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('NetworkSimulator + MockP2PBus branches', () => {
  it('handles dropped and delayed delivery and missing handler', async () => {
    const dropping = new NetworkSimulator({
      baseLatencyMs: 0,
      jitterMs: 0,
      packetLossRate: 1,
      seed: 1,
    });

    const dropped = await dropping.execute(() => 'ok');
    expect(dropped.delivered).toBe(false);

    const delayed = new NetworkSimulator({
      baseLatencyMs: 1,
      jitterMs: 1,
      packetLossRate: 0,
      seed: 2,
    });

    const delivered = await delayed.execute(() => 'ok');
    expect(delivered.delivered).toBe(true);
    expect(delivered.result).toBe('ok');

    const bus = new MockP2PBus(delayed);
    await expect(bus.request('missing-topic', {})).rejects.toThrow('No handler registered');
  });
});

describe('StateSynchronizer branches', () => {
  it('syncs without bridge and ignores duplicate start/stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vhc-sync-'));
    tempDirs.push(dir);
    const syncFile = join(dir, 'state-sync.json');

    const engine = {
      getSupportedSymbols: () => ['ETH-USD'],
      getSnapshot: () => ({ symbol: 'ETH-USD', bids: [], asks: [], sequence: 1 }),
      getStats: () => ({ totalOrders: 0 }),
    } as unknown as MatchingEngine;

    const metrics = new MetricsRegistry();
    const synchronizer = new StateSynchronizer({ syncFilePath: syncFile, intervalMs: 10 }, engine, undefined, metrics);

    synchronizer.start();
    synchronizer.start();
    await synchronizer.syncNow();
    synchronizer.stop();
    synchronizer.stop();

    const content = await readFile(syncFile, 'utf8');
    const parsed = JSON.parse(content) as { anvilBlockNumber?: string; snapshots: unknown[] };
    expect(parsed.anvilBlockNumber).toBeUndefined();
    expect(parsed.snapshots.length).toBe(1);
  });

  it('handles bridge block number read success and failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vhc-sync-'));
    tempDirs.push(dir);
    const syncFile = join(dir, 'state-sync-bridge.json');

    const engine = {
      getSupportedSymbols: () => ['ETH-USD'],
      getSnapshot: () => ({ symbol: 'ETH-USD', bids: [], asks: [], sequence: 2 }),
      getStats: () => ({ totalOrders: 1 }),
    } as unknown as MatchingEngine;

    const metrics = new MetricsRegistry();
    const bridgeOk = {
      getBlockNumber: async () => 99n,
    } as unknown as AnvilBridge;

    const successSync = new StateSynchronizer({ syncFilePath: syncFile, intervalMs: 10 }, engine, bridgeOk, metrics);
    await successSync.syncNow();

    const successContent = JSON.parse(await readFile(syncFile, 'utf8')) as { anvilBlockNumber?: string };
    expect(successContent.anvilBlockNumber).toBe('99');

    const bridgeFail = {
      getBlockNumber: async () => {
        throw new Error('no rpc');
      },
    } as unknown as AnvilBridge;
    const failureSync = new StateSynchronizer({ syncFilePath: syncFile, intervalMs: 10 }, engine, bridgeFail, metrics);
    await failureSync.syncNow();
  });
});

describe('Logger and CommandLog branches', () => {
  it('writes all log levels and returns empty command list when file missing', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logger = new Logger('test');

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(writeSpy).toHaveBeenCalledTimes(4);
    writeSpy.mockRestore();

    const dir = await mkdtemp(join(tmpdir(), 'vhc-command-log-'));
    tempDirs.push(dir);
    const log = new CommandLog(join(dir, 'missing', 'commands.jsonl'));
    await expect(log.readCommands()).resolves.toEqual([]);
  });
});
