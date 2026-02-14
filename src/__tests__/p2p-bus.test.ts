import { describe, expect, it } from 'vitest';

import { NetworkSimulator } from '../network/network-simulator.js';
import { MockP2PBus } from '../network/p2p-bus.js';

describe('MockP2PBus', () => {
  it('routes requests to registered handlers', async () => {
    const bus = new MockP2PBus(
      new NetworkSimulator({
        baseLatencyMs: 0,
        jitterMs: 0,
        packetLossRate: 0,
        seed: 1,
      })
    );

    bus.registerHandler<{ value: number }, number>('math.double', (payload) => payload.value * 2);

    const result = await bus.request<{ value: number }, number>('math.double', { value: 21 });
    expect(result.delivered).toBe(true);
    expect(result.result).toBe(42);
  });
});
