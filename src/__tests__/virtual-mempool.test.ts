import { afterEach, describe, expect, it } from 'vitest';

import { VirtualMempool } from '../bridge/virtual-mempool.js';
import { sleep } from '../utils/time.js';

const createdPools: Array<VirtualMempool<{ id: string }, { id: string }>> = [];

afterEach(() => {
  for (const pool of createdPools) {
    pool.stop();
  }
  createdPools.length = 0;
});

describe('VirtualMempool', () => {
  it('orders inclusion by effective gas price', async () => {
    const executed: string[] = [];

    const pool = new VirtualMempool<{ id: string }, { id: string }>(
      {
        blockIntervalMs: 20,
        maxTransactionsPerBlock: 1,
        defaultConfirmations: 1,
        confirmationProbabilityPerBlock: 1,
      },
      async (payload) => {
        executed.push(payload.id);
        return payload;
      },
      undefined,
      undefined,
      111
    );

    createdPools.push(pool);
    pool.start();

    const lowGas = pool.submit(
      { id: 'low' },
      {
        gasPrice: 1_000n,
        maxPriorityFeePerGas: 0n,
      }
    );

    const highGas = pool.submit(
      { id: 'high' },
      {
        gasPrice: 2_000n,
        maxPriorityFeePerGas: 0n,
      }
    );

    await Promise.all([lowGas.confirmed, highGas.confirmed]);

    expect(executed[0]).toBe('high');
    expect(executed[1]).toBe('low');
  });

  it('tracks pending count and exposes snapshots', async () => {
    const pool = new VirtualMempool<{ id: string }, { id: string }>(
      {
        blockIntervalMs: 25,
        maxTransactionsPerBlock: 5,
        defaultConfirmations: 1,
        confirmationProbabilityPerBlock: 1,
      },
      async (payload) => payload,
      undefined,
      undefined,
      222
    );

    createdPools.push(pool);
    pool.start();

    const tx = pool.submit(
      { id: 'a' },
      {
        gasPrice: 1_000n,
        maxPriorityFeePerGas: 50n,
      }
    );

    expect(pool.getPendingCount()).toBe(1);

    const pendingSnapshot = pool.getTransaction(tx.txId);
    expect(pendingSnapshot?.status).toBe('pending');

    await tx.confirmed;
    await sleep(50);

    const confirmedSnapshot = pool.getTransaction(tx.txId);
    expect(confirmedSnapshot?.status).toBe('confirmed');
    expect(pool.listTransactions(10).length).toBeGreaterThanOrEqual(1);
  });

  it('marks transaction failed when executor throws', async () => {
    const pool = new VirtualMempool<{ id: string }, { id: string }>(
      {
        blockIntervalMs: 20,
        maxTransactionsPerBlock: 5,
        defaultConfirmations: 1,
        confirmationProbabilityPerBlock: 1,
      },
      async () => {
        throw new Error('boom');
      },
      undefined,
      undefined,
      333
    );

    createdPools.push(pool);
    pool.start();

    const tx = pool.submit(
      { id: 'fail' },
      {
        gasPrice: 1_000n,
        maxPriorityFeePerGas: 1n,
      }
    );

    await expect(tx.confirmed).rejects.toThrow('boom');
    const snapshot = pool.listTransactions(10).find((entry) => entry.txId === tx.txId);
    expect(snapshot?.status).toBe('failed');
  });

  it('eventually confirms even when random confirmation check fails', async () => {
    const pool = new VirtualMempool<{ id: string }, { id: string }>(
      {
        blockIntervalMs: 15,
        maxTransactionsPerBlock: 2,
        defaultConfirmations: 1,
        confirmationProbabilityPerBlock: 0,
      },
      async (payload) => payload,
      undefined,
      undefined,
      444
    );

    createdPools.push(pool);
    pool.start();

    const tx = pool.submit(
      { id: 'late-confirm' },
      {
        gasPrice: 1_000n,
        maxPriorityFeePerGas: 1n,
      }
    );

    const confirmed = await tx.confirmed;
    expect(confirmed.status).toBe('confirmed');
    expect(typeof confirmed.confirmedBlockNumber).toBe('number');
  });
});
