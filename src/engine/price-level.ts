import type { BookOrder } from '../types/order.js';

export class OrderQueueNode {
  prev: OrderQueueNode | null = null;
  next: OrderQueueNode | null = null;

  constructor(public readonly order: BookOrder) {}
}

export class PriceLevel {
  head: OrderQueueNode | null = null;
  tail: OrderQueueNode | null = null;

  orderCount = 0;
  totalVisibleQuantity = 0;

  constructor(public readonly price: number) {}

  append(node: OrderQueueNode): void {
    if (!this.head) {
      this.head = node;
      this.tail = node;
    } else {
      this.tail!.next = node;
      node.prev = this.tail;
      this.tail = node;
    }

    this.orderCount += 1;
    this.totalVisibleQuantity += node.order.displayedRemainingQuantity;
  }

  remove(node: OrderQueueNode): void {
    this.unlink(node);
    this.orderCount -= 1;
    this.totalVisibleQuantity -= node.order.displayedRemainingQuantity;
  }

  moveToTail(node: OrderQueueNode): void {
    if (this.tail === node) {
      return;
    }

    this.unlink(node);

    if (!this.tail) {
      this.head = node;
      this.tail = node;
      return;
    }

    node.prev = this.tail;
    node.next = null;
    this.tail.next = node;
    this.tail = node;
  }

  reduceVisibleQuantity(delta: number): void {
    this.totalVisibleQuantity -= delta;
  }

  increaseVisibleQuantity(delta: number): void {
    this.totalVisibleQuantity += delta;
  }

  isEmpty(): boolean {
    return this.orderCount <= 0 || !this.head;
  }

  private unlink(node: OrderQueueNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
    if (this.head === node) {
      this.head = node.next;
    }
    if (this.tail === node) {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }
}
