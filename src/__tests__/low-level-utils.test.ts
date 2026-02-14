import { describe, expect, it, vi } from 'vitest';

import { OrderQueueNode, PriceLevel } from '../engine/price-level.js';
import { XorShift32 } from '../utils/prng.js';
import { buildId } from '../utils/id.js';
import { nowMs, sleep } from '../utils/time.js';

describe('PriceLevel', () => {
  it('appends, moves, removes nodes, and tracks visible quantity', () => {
    const level = new PriceLevel(100);
    const nodeA = new OrderQueueNode({
      id: 'a',
      symbol: 'ETH-USD',
      userId: 'u1',
      side: 'buy',
      kind: 'limit',
      originalQuantity: 5,
      remainingQuantity: 5,
      displayQuantity: 3,
      displayedRemainingQuantity: 3,
      reserveRemainingQuantity: 2,
      minQuantity: 1,
      price: 100,
      status: 'NEW',
      timeInForce: 'GTC',
      selfTradePrevention: 'none',
      createdAtMs: 1,
      updatedAtMs: 1,
      sequence: 1,
    });
    const nodeB = new OrderQueueNode({
      ...nodeA.order,
      id: 'b',
      displayedRemainingQuantity: 2,
      reserveRemainingQuantity: 0,
    });

    level.append(nodeA);
    level.append(nodeB);
    expect(level.orderCount).toBe(2);
    expect(level.totalVisibleQuantity).toBe(5);

    level.moveToTail(nodeA);
    expect(level.tail?.order.id).toBe('a');

    level.reduceVisibleQuantity(1);
    level.increaseVisibleQuantity(4);
    expect(level.totalVisibleQuantity).toBe(8);

    level.remove(nodeB);
    expect(level.orderCount).toBe(1);
    expect(level.isEmpty()).toBe(false);

    level.remove(nodeA);
    expect(level.isEmpty()).toBe(true);
  });
});

describe('XorShift32', () => {
  it('generates deterministic values and validates range inputs', () => {
    const rngA = new XorShift32(0);
    const rngB = new XorShift32(0);

    expect(rngA.nextUint32()).toBe(rngB.nextUint32());
    expect(rngA.nextFloat()).toBeGreaterThanOrEqual(0);
    expect(rngA.nextFloat()).toBeLessThanOrEqual(1);
    expect(rngA.nextInt(3, 3)).toBe(3);
    expect(() => rngA.nextInt(2, 1)).toThrow('invalid range');
  });
});

describe('id and time utils', () => {
  it('builds ids and exposes time helpers', async () => {
    const fixedNow = 1700000000000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const id = buildId('trace');
    expect(id.startsWith('trace_')).toBe(true);

    expect(nowMs()).toBe(fixedNow);

    const start = Date.now();
    await sleep(1);
    const end = Date.now();
    expect(end).toBeGreaterThanOrEqual(start);

    nowSpy.mockRestore();
  });
});
