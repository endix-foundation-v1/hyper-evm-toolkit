import { describe, expect, it } from 'vitest';

import { OrderBook } from '../engine/order-book.js';

function createBook(): OrderBook {
  return new OrderBook('ETH-USD', {
    tickSize: 1,
    lotSize: 1,
    minOrderQuantity: 1,
    maxDepth: 200,
    seed: 123,
  });
}

describe('OrderBook', () => {
  it('enforces price-time priority', () => {
    const book = createBook();

    const makerA = book.submitOrder({
      id: 'maker-a',
      symbol: 'ETH-USD',
      userId: 'maker-a-user',
      side: 'sell',
      kind: 'limit',
      quantity: 5,
      price: 101,
    });

    const makerB = book.submitOrder({
      id: 'maker-b',
      symbol: 'ETH-USD',
      userId: 'maker-b-user',
      side: 'sell',
      kind: 'limit',
      quantity: 5,
      price: 101,
    });

    expect(makerA.order.status).toBe('NEW');
    expect(makerB.order.status).toBe('NEW');

    const taker = book.submitOrder({
      id: 'taker-order',
      symbol: 'ETH-USD',
      userId: 'taker-user',
      side: 'buy',
      kind: 'market',
      quantity: 6,
      timeInForce: 'IOC',
    });

    expect(taker.trades).toHaveLength(2);
    expect(taker.trades[0]?.makerOrderId).toBe('maker-a');
    expect(taker.trades[0]?.quantity).toBe(5);
    expect(taker.trades[1]?.makerOrderId).toBe('maker-b');
    expect(taker.trades[1]?.quantity).toBe(1);
  });

  it('supports partial fills and leaves resting liquidity', () => {
    const book = createBook();

    book.submitOrder({
      id: 'maker-sell',
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 10,
      price: 120,
      timeInForce: 'GTC',
    });

    const taker = book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'buyer-user',
      side: 'buy',
      kind: 'limit',
      quantity: 3,
      price: 130,
      timeInForce: 'IOC',
    });

    expect(taker.order.status).toBe('FILLED');

    const snapshot = book.getSnapshot(5);
    expect(snapshot.asks[0]?.price).toBe(120);
    expect(snapshot.asks[0]?.quantity).toBe(7);
  });

  it('cancels IOC remainder when liquidity is insufficient', () => {
    const book = createBook();

    book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 2,
      price: 150,
      timeInForce: 'GTC',
    });

    const result = book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'ioc-buyer',
      side: 'buy',
      kind: 'limit',
      quantity: 5,
      price: 200,
      timeInForce: 'IOC',
    });

    expect(result.trades).toHaveLength(1);
    expect(result.order.status).toBe('EXPIRED');
    expect(result.order.remainingQuantity).toBe(3);
  });

  it('rejects FOK if full quantity cannot be matched', () => {
    const book = createBook();

    book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 4,
      price: 100,
      timeInForce: 'GTC',
    });

    const result = book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'fok-user',
      side: 'buy',
      kind: 'limit',
      quantity: 5,
      price: 100,
      timeInForce: 'FOK',
    });

    expect(result.order.status).toBe('REJECTED');
    expect(result.trades).toHaveLength(0);
  });

  it('supports cancel by order id', () => {
    const book = createBook();

    const placed = book.submitOrder({
      id: 'cancel-target',
      symbol: 'ETH-USD',
      userId: 'maker-user',
      side: 'sell',
      kind: 'limit',
      quantity: 7,
      price: 90,
      timeInForce: 'GTC',
    });

    expect(placed.order.status).toBe('NEW');

    const canceled = book.cancelOrder('cancel-target', 'maker-user');
    expect(canceled.canceled).toBe(true);
    expect(canceled.order?.status).toBe('CANCELED');

    const snapshot = book.getSnapshot(5);
    expect(snapshot.asks).toHaveLength(0);
  });

  it('replenishes iceberg orders and preserves reserve quantity', () => {
    const book = createBook();

    book.submitOrder({
      id: 'iceberg-maker',
      symbol: 'ETH-USD',
      userId: 'ice-maker',
      side: 'sell',
      kind: 'limit',
      quantity: 10,
      icebergDisplayQuantity: 3,
      price: 100,
      timeInForce: 'GTC',
    });

    const taker = book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'taker-1',
      side: 'buy',
      kind: 'market',
      quantity: 4,
      timeInForce: 'IOC',
    });

    expect(taker.trades).toHaveLength(2);
    const snapshot = book.getSnapshot(10);
    expect(snapshot.asks[0]?.quantity).toBe(2);
  });

  it('applies self-trade prevention cancel_oldest', () => {
    const book = createBook();

    book.submitOrder({
      id: 'old-maker',
      symbol: 'ETH-USD',
      userId: 'same-user',
      side: 'sell',
      kind: 'limit',
      quantity: 5,
      price: 101,
      timeInForce: 'GTC',
    });

    const taker = book.submitOrder({
      symbol: 'ETH-USD',
      userId: 'same-user',
      side: 'buy',
      kind: 'limit',
      quantity: 5,
      price: 101,
      timeInForce: 'IOC',
      selfTradePrevention: 'cancel_oldest',
    });

    expect(taker.trades).toHaveLength(0);
    expect(taker.order.status).toBe('EXPIRED');
    const depth = book.getDepth(5);
    expect(depth.asks).toHaveLength(0);
  });
});
