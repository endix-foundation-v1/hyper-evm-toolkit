import { describe, expect, it } from 'vitest';

import { NumericSkipList } from '../engine/skip-list.js';

describe('NumericSkipList', () => {
  it('supports insert, get, delete and ordered iteration', () => {
    const list = new NumericSkipList<string>(123);
    list.upsert(10, 'ten');
    list.upsert(5, 'five');
    list.upsert(20, 'twenty');

    expect(list.size).toBe(3);
    expect(list.get(10)).toBe('ten');
    expect(list.first()?.key).toBe(5);

    const keys = Array.from(list.entries()).map((entry) => entry.key);
    expect(keys).toEqual([5, 10, 20]);

    const removed = list.delete(10);
    expect(removed).toBe(true);
    expect(list.get(10)).toBeUndefined();
    expect(list.size).toBe(2);
  });

  it('updates existing key via upsert', () => {
    const list = new NumericSkipList<number>(456);
    list.upsert(1, 10);
    list.upsert(1, 20);

    expect(list.size).toBe(1);
    expect(list.get(1)).toBe(20);
  });
});
