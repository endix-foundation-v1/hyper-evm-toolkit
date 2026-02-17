import { describe, expect, it } from 'vitest';

import { NetworkSimulator } from '../network/network-simulator.js';

describe('NetworkSimulator', () => {
  it('returns delivered result when packet loss is zero', async () => {
    const simulator = new NetworkSimulator({
      baseLatencyMs: 0,
      jitterMs: 0,
      packetLossRate: 0,
      seed: 10,
    });

    const result = await simulator.execute(() => 'ok');
    expect(result.delivered).toBe(true);
    expect(result.result).toBe('ok');
  });

  it('drops messages when packet loss is one', async () => {
    const simulator = new NetworkSimulator({
      baseLatencyMs: 0,
      jitterMs: 0,
      packetLossRate: 1,
      seed: 10,
    });

    const result = await simulator.execute(() => 'never');
    expect(result.delivered).toBe(false);
    expect(result.result).toBeUndefined();
  });
});
