import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from 'prom-client';

export class MetricsRegistry {
  readonly registry: Registry;

  readonly ordersTotal: Counter<'kind' | 'side' | 'status'>;
  readonly tradesTotal: Counter<'symbol'>;
  readonly orderProcessingLatencyMs: Histogram<'symbol' | 'kind'>;
  readonly wsConnections: Gauge;
  readonly mempoolPendingTransactions: Gauge;
  readonly networkDroppedMessages: Counter<'topic'>;
  readonly stateSyncCount: Counter;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.ordersTotal = new Counter({
      name: 'virtual_hypercore_orders_total',
      help: 'Total number of orders processed by type and status',
      labelNames: ['kind', 'side', 'status'],
      registers: [this.registry],
    });

    this.tradesTotal = new Counter({
      name: 'virtual_hypercore_trades_total',
      help: 'Total number of trades executed',
      labelNames: ['symbol'],
      registers: [this.registry],
    });

    this.orderProcessingLatencyMs = new Histogram({
      name: 'virtual_hypercore_order_processing_latency_ms',
      help: 'Order processing latency distribution in milliseconds',
      labelNames: ['symbol', 'kind'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250],
      registers: [this.registry],
    });

    this.wsConnections = new Gauge({
      name: 'virtual_hypercore_ws_connections',
      help: 'Current number of websocket client connections',
      registers: [this.registry],
    });

    this.mempoolPendingTransactions = new Gauge({
      name: 'virtual_hypercore_mempool_pending_transactions',
      help: 'Current number of pending virtual mempool transactions',
      registers: [this.registry],
    });

    this.networkDroppedMessages = new Counter({
      name: 'virtual_hypercore_network_dropped_messages_total',
      help: 'Total number of simulated dropped network messages',
      labelNames: ['topic'],
      registers: [this.registry],
    });

    this.stateSyncCount = new Counter({
      name: 'virtual_hypercore_state_sync_total',
      help: 'Total number of state synchronization cycles completed',
      registers: [this.registry],
    });
  }

  observeOrderLatency(symbol: string, kind: string, latencyMs: number): void {
    this.orderProcessingLatencyMs.observe({ symbol, kind } as LabelValues<'symbol' | 'kind'>, latencyMs);
  }
}
