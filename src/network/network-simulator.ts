import type { NetworkSimulationConfig } from '../types/config.js';
import { XorShift32 } from '../utils/prng.js';
import { sleep } from '../utils/time.js';

export interface NetworkSimulationResult<T> {
  delivered: boolean;
  latencyMs: number;
  result?: T;
}

export class NetworkSimulator {
  private readonly random: XorShift32;

  constructor(private readonly config: NetworkSimulationConfig) {
    this.random = new XorShift32(config.seed);
  }

  async execute<T>(action: () => Promise<T> | T): Promise<NetworkSimulationResult<T>> {
    const dropped = this.random.nextFloat() < this.config.packetLossRate;
    const jitter = this.config.jitterMs > 0 ? this.random.nextInt(-this.config.jitterMs, this.config.jitterMs) : 0;
    const latencyMs = Math.max(0, this.config.baseLatencyMs + jitter);

    if (latencyMs > 0) {
      await sleep(latencyMs);
    }

    if (dropped) {
      return {
        delivered: false,
        latencyMs,
      };
    }

    const result = await action();
    return {
      delivered: true,
      latencyMs,
      result,
    };
  }
}
