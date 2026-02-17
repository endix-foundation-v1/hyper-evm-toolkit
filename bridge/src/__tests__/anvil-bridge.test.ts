import { describe, expect, it, vi } from 'vitest';

import { AnvilBridge } from '../bridge/anvil-bridge.js';

const baseConfig = {
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 31337,
};

describe('AnvilBridge', () => {
  it('returns block number from public client', async () => {
    const bridge = new AnvilBridge(baseConfig);
    vi.spyOn(bridge.publicClient, 'getBlockNumber').mockResolvedValue(12n);

    await expect(bridge.getBlockNumber()).resolves.toBe(12n);
  });

  it('mines block when request succeeds', async () => {
    const bridge = new AnvilBridge(baseConfig);
    vi.spyOn(bridge.publicClient, 'request').mockResolvedValue('ok');

    await expect(bridge.mineBlock()).resolves.toBe(true);
  });

  it('returns false when mine request fails', async () => {
    const bridge = new AnvilBridge(baseConfig);
    vi.spyOn(bridge.publicClient, 'request').mockRejectedValue(new Error('mine failed'));

    await expect(bridge.mineBlock()).resolves.toBe(false);
  });

  it('returns undefined when wallet or sink is missing', async () => {
    const bridge = new AnvilBridge(baseConfig);

    await expect(bridge.submitNoopTransaction()).resolves.toBeUndefined();
  });

  it('submits noop transaction when wallet and sink exist', async () => {
    const bridge = new AnvilBridge({
      ...baseConfig,
      privateKey: '0x59c6995e998f97a5a0044966f094538f8a6f8f6f5f95f4f90f86f44c83d8f0d2',
      sinkAddress: '0x0000000000000000000000000000000000000001',
    });

    if (!bridge.walletClient) {
      throw new Error('expected wallet client to exist');
    }

    vi.spyOn(bridge.walletClient, 'sendTransaction').mockResolvedValue(
      '0x1111111111111111111111111111111111111111111111111111111111111111'
    );

    const hash = await bridge.submitNoopTransaction(2_000_000_000n, 200_000_000n);
    expect(hash).toBe('0x1111111111111111111111111111111111111111111111111111111111111111');
  });

  it('returns undefined when sendTransaction throws', async () => {
    const bridge = new AnvilBridge({
      ...baseConfig,
      privateKey: '0x59c6995e998f97a5a0044966f094538f8a6f8f6f5f95f4f90f86f44c83d8f0d2',
      sinkAddress: '0x0000000000000000000000000000000000000001',
    });

    if (!bridge.walletClient) {
      throw new Error('expected wallet client to exist');
    }

    vi.spyOn(bridge.walletClient, 'sendTransaction').mockRejectedValue(new Error('tx failed'));

    await expect(bridge.submitNoopTransaction()).resolves.toBeUndefined();
  });
});
