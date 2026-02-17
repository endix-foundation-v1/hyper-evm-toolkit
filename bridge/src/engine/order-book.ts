import {
  type BookOrder,
  type CancelOrderResult,
  type DepthLevel,
  type OrderBookSnapshot,
  type OrderEvent,
  type OrderRequest,
  type OrderSide,
  type SubmitOrderResult,
  type TimeInForce,
  type TradeRecord,
} from '../types/order.js';
import { buildId } from '../utils/id.js';
import { NumericSkipList } from './skip-list.js';
import { OrderQueueNode, PriceLevel } from './price-level.js';

interface OrderReference {
  level: PriceLevel;
  node: OrderQueueNode;
  side: OrderSide;
}

interface OrderBookOptions {
  tickSize: number;
  lotSize: number;
  minOrderQuantity: number;
  maxDepth: number;
  seed: number;
}

export class OrderBook {
  private readonly bids: NumericSkipList<PriceLevel>;
  private readonly asks: NumericSkipList<PriceLevel>;
  private readonly ordersById = new Map<string, OrderReference>();

  private readonly trades: TradeRecord[] = [];
  private readonly events: OrderEvent[] = [];

  private sequence = 0;

  constructor(
    readonly symbol: string,
    private readonly options: OrderBookOptions
  ) {
    this.bids = new NumericSkipList<PriceLevel>(options.seed + 11);
    this.asks = new NumericSkipList<PriceLevel>(options.seed + 17);
  }

  submitOrder(request: OrderRequest, nowMs = Date.now()): SubmitOrderResult {
    const validationError = this.validateRequest(request);
    const order = this.createOrder(request, nowMs);

    if (validationError) {
      order.status = 'REJECTED';
      const rejectionEvent = this.createOrderEvent(order, 'REJECTED', validationError, nowMs);
      return {
        order: this.cloneOrder(order),
        trades: [],
        events: [rejectionEvent],
      };
    }

    if (order.timeInForce === 'FOK' && !this.hasEnoughLiquidity(order)) {
      order.status = 'REJECTED';
      const rejectionEvent = this.createOrderEvent(
        order,
        'REJECTED',
        'insufficient_liquidity_for_fok',
        nowMs
      );
      return {
        order: this.cloneOrder(order),
        trades: [],
        events: [rejectionEvent],
      };
    }

    const resultEvents: OrderEvent[] = [];
    const resultTrades: TradeRecord[] = [];

    this.matchIncomingOrder(order, nowMs, resultTrades, resultEvents);

    if (order.remainingQuantity > 0) {
      if (order.kind === 'limit' && order.timeInForce === 'GTC') {
        this.prepareOrderForBook(order);
        this.addOrderToBook(order);

        const status = order.remainingQuantity === order.originalQuantity ? 'NEW' : 'PARTIALLY_FILLED';
        order.status = status;
        const event = this.createOrderEvent(order, status, undefined, nowMs);
        resultEvents.push(event);
      } else {
        order.status = 'EXPIRED';
        const expiredEvent = this.createOrderEvent(
          order,
          'EXPIRED',
          order.kind === 'market' ? 'market_order_unfilled_remainder' : 'time_in_force_unfilled_remainder',
          nowMs
        );
        resultEvents.push(expiredEvent);
      }
    } else {
      order.status = 'FILLED';
      const fillEvent = this.createOrderEvent(order, 'FILLED', undefined, nowMs);
      resultEvents.push(fillEvent);
    }

    return {
      order: this.cloneOrder(order),
      trades: resultTrades,
      events: resultEvents,
    };
  }

  cancelOrder(orderId: string, userId?: string, nowMs = Date.now()): CancelOrderResult {
    const orderReference = this.ordersById.get(orderId);
    if (!orderReference) {
      return {
        canceled: false,
        reason: 'order_not_found',
      };
    }

    if (userId && orderReference.node.order.userId !== userId) {
      return {
        canceled: false,
        reason: 'user_mismatch',
      };
    }

    const { level, node, side } = orderReference;
    level.remove(node);
    this.ordersById.delete(orderId);

    if (level.isEmpty()) {
      this.removeLevel(side, level.price);
    }

    node.order.status = 'CANCELED';
    node.order.updatedAtMs = nowMs;

    const event = this.createOrderEvent(node.order, 'CANCELED', 'canceled_by_user', nowMs);
    return {
      canceled: true,
      order: this.cloneOrder(node.order),
      event,
    };
  }

  getSnapshot(depth = this.options.maxDepth): OrderBookSnapshot {
    return {
      symbol: this.symbol,
      sequence: this.sequence,
      timestampMs: Date.now(),
      bids: this.collectDepth('buy', depth),
      asks: this.collectDepth('sell', depth),
    };
  }

  getDepth(depth = this.options.maxDepth): { bids: DepthLevel[]; asks: DepthLevel[] } {
    return {
      bids: this.collectDepth('buy', depth),
      asks: this.collectDepth('sell', depth),
    };
  }

  getTrades(limit = 200): TradeRecord[] {
    return this.trades.slice(-limit);
  }

  getEvents(limit = 200): OrderEvent[] {
    return this.events.slice(-limit);
  }

  getActiveOrderCount(): number {
    return this.ordersById.size;
  }

  private validateRequest(request: OrderRequest): string | null {
    if (request.symbol !== this.symbol) {
      return 'symbol_mismatch';
    }

    if (!request.userId) {
      return 'missing_user_id';
    }

    if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
      return 'invalid_quantity';
    }

    if (!this.isStepMultiple(request.quantity, this.options.lotSize)) {
      return 'quantity_not_lot_multiple';
    }

    if (request.quantity < this.options.minOrderQuantity) {
      return 'quantity_below_minimum';
    }

    if (request.kind === 'limit') {
      if (request.price === undefined || !Number.isFinite(request.price) || request.price <= 0) {
        return 'invalid_limit_price';
      }

      if (!this.isStepMultiple(request.price, this.options.tickSize)) {
        return 'price_not_tick_multiple';
      }
    }

    if (request.kind === 'market' && request.price !== undefined) {
      return 'market_order_cannot_have_price';
    }

    if (request.minQuantity !== undefined) {
      if (request.minQuantity <= 0 || request.minQuantity > request.quantity) {
        return 'invalid_min_quantity';
      }

      if (!this.isStepMultiple(request.minQuantity, this.options.lotSize)) {
        return 'min_quantity_not_lot_multiple';
      }
    }

    if (request.icebergDisplayQuantity !== undefined) {
      if (request.kind !== 'limit') {
        return 'iceberg_requires_limit_order';
      }

      if (
        request.icebergDisplayQuantity <= 0 ||
        request.icebergDisplayQuantity > request.quantity ||
        !this.isStepMultiple(request.icebergDisplayQuantity, this.options.lotSize)
      ) {
        return 'invalid_iceberg_display_quantity';
      }
    }

    return null;
  }

  private createOrder(request: OrderRequest, timestampMs: number): BookOrder {
    this.sequence += 1;

    const timeInForce = this.resolveTimeInForce(request.kind, request.timeInForce);
    const displayQuantity = request.icebergDisplayQuantity ?? request.quantity;
    const displayedRemainingQuantity = Math.min(displayQuantity, request.quantity);
    const reserveRemainingQuantity = request.quantity - displayedRemainingQuantity;

    return {
      id: request.id ?? buildId('ord'),
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      userId: request.userId,
      side: request.side,
      kind: request.kind,
      timeInForce,
      status: 'NEW',
      price: request.price,
      originalQuantity: request.quantity,
      remainingQuantity: request.quantity,
      displayQuantity,
      displayedRemainingQuantity,
      reserveRemainingQuantity,
      minQuantity: request.minQuantity ?? this.options.minOrderQuantity,
      selfTradePrevention: request.selfTradePrevention ?? 'none',
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
      sequence: this.sequence,
    };
  }

  private resolveTimeInForce(kind: 'limit' | 'market', requestTif?: TimeInForce): TimeInForce {
    if (kind === 'market') {
      return requestTif ?? 'IOC';
    }

    return requestTif ?? 'GTC';
  }

  private matchIncomingOrder(
    takerOrder: BookOrder,
    nowMs: number,
    resultTrades: TradeRecord[],
    resultEvents: OrderEvent[]
  ): void {
    while (takerOrder.remainingQuantity > 0) {
      const bestLevel = this.getBestOppositeLevel(takerOrder.side);
      if (!bestLevel) {
        break;
      }

      if (
        takerOrder.kind === 'limit' &&
        takerOrder.price !== undefined &&
        !this.isCrossingPrice(takerOrder.side, takerOrder.price, bestLevel.price)
      ) {
        break;
      }

      let makerNode = bestLevel.head;
      if (!makerNode) {
        this.removeLevel(this.oppositeSide(takerOrder.side), bestLevel.price);
        continue;
      }

      const makerOrder = makerNode.order;
      const stpOutcome = this.resolveSelfTradePrevention(takerOrder, makerOrder, makerNode, bestLevel, nowMs);

      if (stpOutcome === 'continue') {
        continue;
      }

      if (stpOutcome === 'cancel_taker') {
        takerOrder.status = 'CANCELED';
        const stpEvent = this.createOrderEvent(
          takerOrder,
          'CANCELED',
          'self_trade_prevention_cancel_newest',
          nowMs
        );
        resultEvents.push(stpEvent);
        takerOrder.remainingQuantity = 0;
        return;
      }

      if (stpOutcome === 'cancel_both') {
        takerOrder.status = 'CANCELED';
        const stpEvent = this.createOrderEvent(
          takerOrder,
          'CANCELED',
          'self_trade_prevention_cancel_both',
          nowMs
        );
        resultEvents.push(stpEvent);
        takerOrder.remainingQuantity = 0;
        return;
      }

      makerNode = bestLevel.head;
      if (!makerNode) {
        continue;
      }

      const activeMakerOrder = makerNode.order;
      const executableQuantity = Math.min(
        takerOrder.remainingQuantity,
        activeMakerOrder.displayedRemainingQuantity
      );

      if (executableQuantity <= 0) {
        break;
      }

      this.sequence += 1;
      const trade = this.createTradeRecord(
        activeMakerOrder,
        takerOrder,
        executableQuantity,
        bestLevel.price,
        nowMs,
        this.sequence
      );

      resultTrades.push(trade);
      this.trades.push(trade);

      takerOrder.remainingQuantity -= executableQuantity;
      takerOrder.updatedAtMs = nowMs;

      activeMakerOrder.remainingQuantity -= executableQuantity;
      activeMakerOrder.displayedRemainingQuantity -= executableQuantity;
      activeMakerOrder.updatedAtMs = nowMs;

      bestLevel.reduceVisibleQuantity(executableQuantity);

      if (activeMakerOrder.remainingQuantity === 0) {
        this.removeOrderFromBook(activeMakerOrder.id, makerNode, bestLevel, activeMakerOrder.side);
        activeMakerOrder.status = 'FILLED';
        const makerFilledEvent = this.createOrderEvent(activeMakerOrder, 'FILLED', undefined, nowMs);
        resultEvents.push(makerFilledEvent);
      } else {
        activeMakerOrder.status = 'PARTIALLY_FILLED';
        if (
          activeMakerOrder.displayedRemainingQuantity === 0 &&
          activeMakerOrder.reserveRemainingQuantity > 0
        ) {
          const replenishQuantity = Math.min(
            activeMakerOrder.displayQuantity,
            activeMakerOrder.reserveRemainingQuantity
          );
          activeMakerOrder.displayedRemainingQuantity = replenishQuantity;
          activeMakerOrder.reserveRemainingQuantity -= replenishQuantity;
          bestLevel.increaseVisibleQuantity(replenishQuantity);
          bestLevel.moveToTail(makerNode);
        }
      }
    }
  }

  private createTradeRecord(
    maker: BookOrder,
    taker: BookOrder,
    quantity: number,
    price: number,
    timestampMs: number,
    sequence: number
  ): TradeRecord {
    const buyOrder = taker.side === 'buy' ? taker : maker;
    const sellOrder = taker.side === 'sell' ? taker : maker;

    return {
      tradeId: buildId('trd'),
      symbol: this.symbol,
      price,
      quantity,
      takerSide: taker.side,
      takerOrderId: taker.id,
      makerOrderId: maker.id,
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
      buyUserId: buyOrder.userId,
      sellUserId: sellOrder.userId,
      timestampMs,
      sequence,
    };
  }

  private resolveSelfTradePrevention(
    takerOrder: BookOrder,
    makerOrder: BookOrder,
    makerNode: OrderQueueNode,
    makerLevel: PriceLevel,
    nowMs: number
  ): 'proceed' | 'continue' | 'cancel_taker' | 'cancel_both' {
    if (takerOrder.userId !== makerOrder.userId) {
      return 'proceed';
    }

    const mode = takerOrder.selfTradePrevention;
    if (mode === 'none') {
      return 'proceed';
    }

    if (mode === 'cancel_oldest') {
      this.removeOrderFromBook(makerOrder.id, makerNode, makerLevel, makerOrder.side);
      makerOrder.status = 'CANCELED';
      makerOrder.updatedAtMs = nowMs;
      this.createOrderEvent(makerOrder, 'CANCELED', 'self_trade_prevention_cancel_oldest', nowMs);
      return 'continue';
    }

    if (mode === 'cancel_newest') {
      return 'cancel_taker';
    }

    this.removeOrderFromBook(makerOrder.id, makerNode, makerLevel, makerOrder.side);
    makerOrder.status = 'CANCELED';
    makerOrder.updatedAtMs = nowMs;
    this.createOrderEvent(makerOrder, 'CANCELED', 'self_trade_prevention_cancel_both', nowMs);
    return 'cancel_both';
  }

  private hasEnoughLiquidity(order: BookOrder): boolean {
    let cumulativeQuantity = 0;
    const levels = order.side === 'buy' ? this.asks : this.bids;

    for (const levelEntry of levels.entries()) {
      const level = levelEntry.value;
      if (order.kind === 'limit' && order.price !== undefined) {
        if (!this.isCrossingPrice(order.side, order.price, level.price)) {
          break;
        }
      }

      cumulativeQuantity += level.totalVisibleQuantity;
      if (cumulativeQuantity >= order.remainingQuantity) {
        return true;
      }
    }

    return false;
  }

  private prepareOrderForBook(order: BookOrder): void {
    const displayed = Math.min(order.displayQuantity, order.remainingQuantity);
    order.displayedRemainingQuantity = displayed;
    order.reserveRemainingQuantity = order.remainingQuantity - displayed;
  }

  private addOrderToBook(order: BookOrder): void {
    if (order.price === undefined) {
      return;
    }

    const level = this.getOrCreateLevel(order.side, order.price);
    const node = new OrderQueueNode(order);
    level.append(node);

    this.ordersById.set(order.id, {
      level,
      node,
      side: order.side,
    });
  }

  private removeOrderFromBook(
    orderId: string,
    node: OrderQueueNode,
    level: PriceLevel,
    side: OrderSide
  ): void {
    level.remove(node);
    this.ordersById.delete(orderId);

    if (level.isEmpty()) {
      this.removeLevel(side, level.price);
    }
  }

  private createOrderEvent(
    order: BookOrder,
    status: OrderEvent['status'],
    reason: string | undefined,
    timestampMs: number
  ): OrderEvent {
    this.sequence += 1;
    const event: OrderEvent = {
      eventId: buildId('evt'),
      orderId: order.id,
      symbol: order.symbol,
      status,
      reason,
      remainingQuantity: order.remainingQuantity,
      timestampMs,
      sequence: this.sequence,
    };

    this.events.push(event);
    return event;
  }

  private getBestOppositeLevel(side: OrderSide): PriceLevel | null {
    const levelEntry = side === 'buy' ? this.asks.first() : this.bids.first();
    if (!levelEntry) {
      return null;
    }
    return levelEntry.value;
  }

  private getOrCreateLevel(side: OrderSide, price: number): PriceLevel {
    const index = this.indexForSide(side);
    const internalPrice = this.toInternalPrice(side, price);
    const existing = index.get(internalPrice);
    if (existing) {
      return existing;
    }

    const level = new PriceLevel(price);
    index.upsert(internalPrice, level);
    return level;
  }

  private removeLevel(side: OrderSide, price: number): void {
    const index = this.indexForSide(side);
    const internalPrice = this.toInternalPrice(side, price);
    index.delete(internalPrice);
  }

  private collectDepth(side: OrderSide, depth: number): DepthLevel[] {
    const index = this.indexForSide(side);
    const levels: DepthLevel[] = [];

    for (const entry of index.entries(depth)) {
      const level = entry.value;
      levels.push({
        price: level.price,
        quantity: level.totalVisibleQuantity,
        orderCount: level.orderCount,
      });
    }

    return levels;
  }

  private cloneOrder(order: BookOrder): BookOrder {
    return { ...order };
  }

  private isCrossingPrice(side: OrderSide, incomingPrice: number, bookPrice: number): boolean {
    if (side === 'buy') {
      return incomingPrice >= bookPrice;
    }
    return incomingPrice <= bookPrice;
  }

  private oppositeSide(side: OrderSide): OrderSide {
    return side === 'buy' ? 'sell' : 'buy';
  }

  private toInternalPrice(side: OrderSide, price: number): number {
    return side === 'buy' ? -price : price;
  }

  private indexForSide(side: OrderSide): NumericSkipList<PriceLevel> {
    return side === 'buy' ? this.bids : this.asks;
  }

  private isStepMultiple(value: number, step: number): boolean {
    if (step <= 0) {
      return false;
    }

    const quotient = value / step;
    return Math.abs(quotient - Math.round(quotient)) <= 1e-9;
  }
}
