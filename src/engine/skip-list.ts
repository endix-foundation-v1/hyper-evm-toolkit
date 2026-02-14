import { XorShift32 } from '../utils/prng.js';

interface SkipNode<T> {
  key: number;
  value?: T;
  forwards: Array<SkipNode<T> | null>;
}

function createNode<T>(key: number, value: T | undefined, level: number): SkipNode<T> {
  return {
    key,
    value,
    forwards: Array.from({ length: level }, () => null),
  };
}

export class NumericSkipList<T> {
  private static readonly MAX_LEVEL = 16;
  private static readonly LEVEL_PROBABILITY = 0.5;

  private readonly head: SkipNode<T>;
  private level = 1;
  private readonly random: XorShift32;

  size = 0;

  constructor(seed = 1) {
    this.head = createNode<T>(Number.NEGATIVE_INFINITY, undefined, NumericSkipList.MAX_LEVEL);
    this.random = new XorShift32(seed);
  }

  get(key: number): T | undefined {
    let cursor = this.head;

    for (let i = this.level - 1; i >= 0; i -= 1) {
      while (cursor.forwards[i] && cursor.forwards[i]!.key < key) {
        cursor = cursor.forwards[i]!;
      }
    }

    const candidate = cursor.forwards[0];
    if (candidate && candidate.key === key) {
      return candidate.value;
    }

    return undefined;
  }

  upsert(key: number, value: T): void {
    const update = Array.from({ length: NumericSkipList.MAX_LEVEL }, () => this.head);
    let cursor = this.head;

    for (let i = this.level - 1; i >= 0; i -= 1) {
      while (cursor.forwards[i] && cursor.forwards[i]!.key < key) {
        cursor = cursor.forwards[i]!;
      }
      update[i] = cursor;
    }

    const existing = cursor.forwards[0];
    if (existing && existing.key === key) {
      existing.value = value;
      return;
    }

    const nodeLevel = this.nextLevel();
    if (nodeLevel > this.level) {
      for (let i = this.level; i < nodeLevel; i += 1) {
        update[i] = this.head;
      }
      this.level = nodeLevel;
    }

    const node = createNode(key, value, nodeLevel);
    for (let i = 0; i < nodeLevel; i += 1) {
      node.forwards[i] = update[i].forwards[i];
      update[i].forwards[i] = node;
    }

    this.size += 1;
  }

  delete(key: number): boolean {
    const update = Array.from({ length: NumericSkipList.MAX_LEVEL }, () => this.head);
    let cursor = this.head;

    for (let i = this.level - 1; i >= 0; i -= 1) {
      while (cursor.forwards[i] && cursor.forwards[i]!.key < key) {
        cursor = cursor.forwards[i]!;
      }
      update[i] = cursor;
    }

    const target = cursor.forwards[0];
    if (!target || target.key !== key) {
      return false;
    }

    for (let i = 0; i < this.level; i += 1) {
      if (update[i].forwards[i] !== target) {
        continue;
      }
      update[i].forwards[i] = target.forwards[i];
    }

    while (this.level > 1 && !this.head.forwards[this.level - 1]) {
      this.level -= 1;
    }

    this.size -= 1;
    return true;
  }

  first(): { key: number; value: T } | null {
    const node = this.head.forwards[0];
    if (!node || node.value === undefined) {
      return null;
    }

    return {
      key: node.key,
      value: node.value,
    };
  }

  *entries(limit?: number): Generator<{ key: number; value: T }, void, undefined> {
    let cursor = this.head.forwards[0];
    let yielded = 0;

    while (cursor) {
      if (cursor.value !== undefined) {
        yield {
          key: cursor.key,
          value: cursor.value,
        };

        yielded += 1;
        if (limit !== undefined && yielded >= limit) {
          return;
        }
      }

      cursor = cursor.forwards[0];
    }
  }

  private nextLevel(): number {
    let nextLevel = 1;
    while (
      nextLevel < NumericSkipList.MAX_LEVEL &&
      this.random.nextFloat() < NumericSkipList.LEVEL_PROBABILITY
    ) {
      nextLevel += 1;
    }

    return nextLevel;
  }
}
