import { describe, expect, it } from 'vitest';

import { OrderBook } from '../engine/order-book.js';

function createBook(options?: Partial<{ tickSize: number; lotSize: number; minOrderQuantity: number }>) {
  return new OrderBook('ETH-USD', {
    tickSize: options?.tickSize ?? 1,
    lotSize: options?.lotSize ?? 1,
    minOrderQuantity: options?.minOrderQuantity ?? 1,
    maxDepth: 50,
    seed: 9,
  });
}

describe('OrderBook validation and edge cases', () => {
  it('rejects malformed orders with explicit reasons', () => {
    const book = createBook();

    const invalidCases = [
      {
        payload: {
          symbol: 'BTC-USD',
          userId: 'u',
          side: 'buy',
          kind: 'limit',
          quantity: 1,
          price: 10,
        },
        reason: 'symbol_mismatch',
      },
      {
        payload: {
          symbol: 'ETH-USD',
          userId: '',
          side: 'buy',
          kind: 'limit',
          quantity: 1,
          price: 10,
        },
        reason: 'missing_user_id',
      },
      {
        payload: {
          symbol: 'ETH-USD',
          userId: 'u',
          side: 'buy',
          kind: 'limit',
          quantity: 0,
          price: 10,
        },
        reason: 'invalid_quantity',
      },
      {
        payload: {
          symbol: 'ETH-USD',
          userId: 'u',
          side: 'buy',
          kind: 'limit',
          quantity: 1,
          price: 0,
        },
        reason: 'invalid_limit_price',
      },
      {
        payload: {
          symbol: 'ETH-USD',
          userId: 'u',
          side: 'buy',
          kind: 'market',
          quantity: 2,
          price: 10,
        },
        reason: 'market_order_cannot_have_price',
      },
      {
        payload: {
          symbol: 'ETH-USD',
          userId: 'u',
          side: 'buy',
          kind: 'market',
          quantity: 2,
          minQuantity: 3,
        },
        reason: 'invalid_min_quantity',
      },
      {
        payload: {
          symbol: 'ETH-USD',
          userId: 'u',
          side: 'buy',
          kind: 'market',
          quantity: 2,
          icebergDisplayQuantity: 1,
        },
        reason: 'iceberg_requires_limit_order',
      },
    ] as const;

    for (const testCase of invalidCases) {
      const result = book.submitOrder(testCase.payload as never);
      expect(result.order.status).toBe('REJECTED');
      expect(result.events[0]?.reason).toBe(testCase.reason);
    }
  });

  it('validates tick and lot size multiples', () => {
    const lotBook = createBook({ lotSize: 5 });
    const lotResult = lotBook.submitOrder({
      symbol: 'ETH-USD',
      userId: 'u',
      side: 'buy',
      kind: 'limit',
      quantity: 7,
      price: 20,
    });
    expect(lotResult.events[0]?.reason).toBe('quantity_not_lot_multiple');

    const tickBook = createBook({ tickSize: 5 });
    const tickResult = tickBook.submitOrder({
      symbol: 'ETH-USD',
      userId: 'u',
      side: 'buy',
      kind: 'limit',
      quantity: 10,
      price: 23,
    });
    expect(tickResult.events[0]?.reason).toBe('price_not_tick_multiple');
  });

  it('returns cancel user mismatch and not found results', () => {
    const book = createBook();

    const notFound = book.cancelOrder('missing-order-id', 'u');
    expect(notFound.canceled).toBe(false);
    expect(notFound.reason).toBe('order_not_found');

    book.submitOrder({
      id: 'target',
      symbol: 'ETH-USD',
      userId: 'maker',
      side: 'sell',
      kind: 'limit',
      quantity: 2,
      price: 101,
      timeInForce: 'GTC',
    });

    const mismatch = book.cancelOrder('target', 'different-user');
    expect(mismatch.canceled).toBe(false);
    expect(mismatch.reason).toBe('user_mismatch');
  });
});
