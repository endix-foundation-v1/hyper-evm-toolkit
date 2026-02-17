import type {
  CancelOrderResult,
  OrderBookSnapshot,
  OrderRequest,
  OrderSide,
  SubmitOrderResult,
  TradeRecord,
} from './order.js';

export interface EngineStats {
  startedAtMs: number;
  totalOrdersSubmitted: number;
  totalOrdersCanceled: number;
  totalTradesExecuted: number;
  rejectedOrders: number;
  expiredOrders: number;
  activeOrders: number;
  avgProcessingLatencyMs: number;
  p95ProcessingLatencyMs: number;
}

export interface OrderBookEventPayload {
  symbol: string;
  snapshot: OrderBookSnapshot;
}

export interface TradeEventPayload {
  symbol: string;
  trade: TradeRecord;
}

export interface StatusEventPayload {
  stats: EngineStats;
}

export interface EngineCommandBase {
  commandId: string;
  timestampMs: number;
}

export interface SubmitOrderCommand extends EngineCommandBase {
  type: 'submit_order';
  payload: OrderRequest;
}

export interface CancelOrderCommand extends EngineCommandBase {
  type: 'cancel_order';
  payload: {
    orderId: string;
    userId?: string;
    symbol?: string;
  };
}

export type EngineCommand = SubmitOrderCommand | CancelOrderCommand;

export interface ReplayResult {
  appliedCommands: number;
  skippedCommands: number;
}

export interface VirtualTransactionCommand {
  commandType: 'submit_order' | 'cancel_order';
  orderRequest?: OrderRequest;
  cancelRequest?: {
    orderId: string;
    userId?: string;
    symbol?: string;
  };
}

export interface VirtualTransactionExecutionResult {
  kind: 'submit_order' | 'cancel_order';
  submitOrderResult?: SubmitOrderResult;
  cancelOrderResult?: CancelOrderResult;
}

export interface ExchangeOrderAction {
  asset: string;
  side: OrderSide;
  price?: number;
  quantity: number;
  orderType: 'limit' | 'market';
  tif?: 'Gtc' | 'Ioc' | 'Fok';
  cloid?: string;
  user: string;
}
