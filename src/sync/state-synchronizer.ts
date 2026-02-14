import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MatchingEngine } from '../engine/matching-engine.js';
import type { AnvilBridge } from '../bridge/anvil-bridge.js';
import { Logger } from '../logging/logger.js';
import type { MetricsRegistry } from '../metrics/registry.js';

const logger = new Logger('state-synchronizer');

export interface StateSynchronizerOptions {
  syncFilePath: string;
  intervalMs: number;
}

export class StateSynchronizer {
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: StateSynchronizerOptions,
    private readonly engine: MatchingEngine,
    private readonly bridge: AnvilBridge | undefined,
    private readonly metrics: MetricsRegistry
  ) {}

  start(): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      void this.syncNow();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async syncNow(): Promise<void> {
    const symbols = this.engine.getSupportedSymbols();
    const snapshots = symbols.map((symbol) => this.engine.getSnapshot(symbol, 50));

    let anvilBlockNumber: string | undefined;
    if (this.bridge) {
      try {
        anvilBlockNumber = (await this.bridge.getBlockNumber()).toString();
      } catch (error) {
        logger.warn('could not read anvil block number', {
          error: String(error),
        });
      }
    }

    const payload = {
      syncedAt: new Date().toISOString(),
      anvilBlockNumber,
      stats: this.engine.getStats(),
      snapshots,
    };

    await mkdir(dirname(this.options.syncFilePath), { recursive: true });
    await writeFile(this.options.syncFilePath, JSON.stringify(payload, null, 2), 'utf8');
    this.metrics.stateSyncCount.inc();
  }
}
