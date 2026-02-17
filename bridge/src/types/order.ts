export type OrderSide = 'buy' | 'sell';
export type OrderKind = 'limit' | 'market';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

export type SelfTradePreventionMode =
  | 'none'
  | 'cancel_newest'
  | 'cancel_oldest'
  | 'cancel_both';

export interface OrderRequest {
  id?: string;
  clientOrderId?: string;
  symbol: string;
  userId: string;
  side: OrderSide;
  kind: OrderKind;
  quantity: number;
  price?: number;
  timeInForce?: TimeInForce;
  minQuantity?: number;
  icebergDisplayQuantity?: number;
  selfTradePrevention?: SelfTradePreventionMode;
}

export interface BookOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  userId: string;
  side: OrderSide;
  kind: OrderKind;
  timeInForce: TimeInForce;
  status: OrderStatus;
  price?: number;
  originalQuantity: number;
  remainingQuantity: number;
  displayQuantity: number;
  displayedRemainingQuantity: number;
  reserveRemainingQuantity: number;
  minQuantity: number;
  selfTradePrevention: SelfTradePreventionMode;
  createdAtMs: number;
  updatedAtMs: number;
  sequence: number;
}

export interface TradeRecord {
  tradeId: string;
  symbol: string;
  price: number;
  quantity: number;
  takerSide: OrderSide;
  takerOrderId: string;
  makerOrderId: string;
  buyOrderId: string;
  sellOrderId: string;
  buyUserId: string;
  sellUserId: string;
  timestampMs: number;
  sequence: number;
}

export interface OrderEvent {
  eventId: string;
  orderId: string;
  symbol: string;
  status: OrderStatus;
  reason?: string;
  remainingQuantity: number;
  timestampMs: number;
  sequence: number;
}

export interface SubmitOrderResult {
  order: BookOrder;
  trades: TradeRecord[];
  events: OrderEvent[];
}

export interface CancelOrderResult {
  canceled: boolean;
  order?: BookOrder;
  reason?: string;
  event?: OrderEvent;
}

export interface DepthLevel {
  price: number;
  quantity: number;
  orderCount: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  sequence: number;
  timestampMs: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}
