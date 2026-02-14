import { EventEmitter } from 'node:events';

import type { EngineConfig } from '../types/config.js';
import type {
  CancelOrderCommand,
  EngineCommand,
  EngineStats,
  ReplayResult,
  SubmitOrderCommand,
} from '../types/engine.js';
import type { CancelOrderResult, OrderBookSnapshot, OrderRequest, SubmitOrderResult } from '../types/order.js';
import { buildId } from '../utils/id.js';
import { CommandLog } from '../logging/command-log.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import { OrderBook } from './order-book.js';

interface MatchingEngineOptions {
  config: EngineConfig;
  commandLog: CommandLog;
  metrics: MetricsRegistry;
  randomSeed: number;
}

interface ProcessingMetrics {
  lastLatencies: number[];
  maxSamples: number;
}

export class MatchingEngine extends EventEmitter {
  private readonly books = new Map<string, OrderBook>();
  private readonly orderToSymbol = new Map<string, string>();
  private readonly startedAtMs = Date.now();

  private readonly processingMetrics: ProcessingMetrics = {
    lastLatencies: [],
    maxSamples: 2000,
  };

  private totalOrdersSubmitted = 0;
  private totalOrdersCanceled = 0;
  private totalTradesExecuted = 0;
  private rejectedOrders = 0;
  private expiredOrders = 0;

  constructor(private readonly options: MatchingEngineOptions) {
    super();

    options.config.symbols.forEach((symbol, index) => {
      const book = new OrderBook(symbol, {
        tickSize: options.config.tickSize,
        lotSize: options.config.lotSize,
        minOrderQuantity: options.config.minOrderQuantity,
        maxDepth: options.config.maxOrderBookDepth,
        seed: options.randomSeed + index,
      });

      this.books.set(symbol, book);
    });
  }

  async submitOrder(request: OrderRequest): Promise<SubmitOrderResult> {
    const command: SubmitOrderCommand = {
      commandId: buildId('cmd'),
      type: 'submit_order',
      timestampMs: Date.now(),
      payload: request,
    };

    return this.applySubmitOrder(command, true);
  }

  async cancelOrder(orderId: string, userId?: string, symbol?: string): Promise<CancelOrderResult> {
    const command: CancelOrderCommand = {
      commandId: buildId('cmd'),
      type: 'cancel_order',
      timestampMs: Date.now(),
      payload: {
        orderId,
        userId,
        symbol,
      },
    };

    return this.applyCancelOrder(command, true);
  }

  async replayFromCommandLog(): Promise<ReplayResult> {
    const commands = await this.options.commandLog.readCommands();

    let appliedCommands = 0;
    let skippedCommands = 0;

    for (const command of commands) {
      try {
        if (command.type === 'submit_order') {
          await this.applySubmitOrder(command, false);
          appliedCommands += 1;
        } else if (command.type === 'cancel_order') {
          await this.applyCancelOrder(command, false);
          appliedCommands += 1;
        }
      } catch {
        skippedCommands += 1;
      }
    }

    return {
      appliedCommands,
      skippedCommands,
    };
  }

  getSnapshot(symbol: string, depth?: number): OrderBookSnapshot {
    const book = this.getBook(symbol);
    return book.getSnapshot(depth);
  }

  getTrades(symbol: string, limit?: number) {
    const book = this.getBook(symbol);
    return book.getTrades(limit);
  }

  getDepth(symbol: string, depth?: number) {
    const book = this.getBook(symbol);
    return book.getDepth(depth);
  }

  getStats(): EngineStats {
    const activeOrders = Array.from(this.books.values()).reduce(
      (sum, book) => sum + book.getActiveOrderCount(),
      0
    );

    return {
      startedAtMs: this.startedAtMs,
      totalOrdersSubmitted: this.totalOrdersSubmitted,
      totalOrdersCanceled: this.totalOrdersCanceled,
      totalTradesExecuted: this.totalTradesExecuted,
      rejectedOrders: this.rejectedOrders,
      expiredOrders: this.expiredOrders,
      activeOrders,
      avgProcessingLatencyMs: this.computeAvgLatency(),
      p95ProcessingLatencyMs: this.computeP95Latency(),
    };
  }

  getSupportedSymbols(): string[] {
    return Array.from(this.books.keys());
  }

  private async applySubmitOrder(
    command: SubmitOrderCommand,
    persistCommand: boolean
  ): Promise<SubmitOrderResult> {
    if (persistCommand) {
      await this.options.commandLog.appendCommand(command);
    }

    const startedAt = performance.now();
    const book = this.getBook(command.payload.symbol);
    const result = book.submitOrder(command.payload, command.timestampMs);
    const latencyMs = performance.now() - startedAt;

    this.recordProcessingLatency(latencyMs);
    this.totalOrdersSubmitted += 1;
    this.totalTradesExecuted += result.trades.length;

    if (result.order.status === 'REJECTED') {
      this.rejectedOrders += 1;
    }
    if (result.order.status === 'EXPIRED') {
      this.expiredOrders += 1;
    }

    if (result.order.remainingQuantity > 0 && result.order.kind === 'limit' && result.order.timeInForce === 'GTC') {
      this.orderToSymbol.set(result.order.id, result.order.symbol);
    } else {
      this.orderToSymbol.delete(result.order.id);
    }

    for (const event of result.events) {
      if (event.status === 'FILLED' || event.status === 'CANCELED' || event.status === 'EXPIRED') {
        this.orderToSymbol.delete(event.orderId);
      }
    }

    this.options.metrics.ordersTotal.inc({
      kind: result.order.kind,
      side: result.order.side,
      status: result.order.status,
    });
    this.options.metrics.observeOrderLatency(result.order.symbol, result.order.kind, latencyMs);

    for (const trade of result.trades) {
      this.options.metrics.tradesTotal.inc({ symbol: trade.symbol });
    }

    await this.options.commandLog.appendEvent({
      commandId: command.commandId,
      result,
    });

    this.emit('order_result', result);
    for (const trade of result.trades) {
      this.emit('trade', trade);
    }
    this.emit('orderbook', {
      symbol: result.order.symbol,
      snapshot: book.getSnapshot(),
    });

    return result;
  }

  private async applyCancelOrder(
    command: CancelOrderCommand,
    persistCommand: boolean
  ): Promise<CancelOrderResult> {
    if (persistCommand) {
      await this.options.commandLog.appendCommand(command);
    }

    const targetSymbol = command.payload.symbol ?? this.orderToSymbol.get(command.payload.orderId);
    if (!targetSymbol) {
      return {
        canceled: false,
        reason: 'order_symbol_not_found',
      };
    }

    const book = this.getBook(targetSymbol);
    const result = book.cancelOrder(command.payload.orderId, command.payload.userId, command.timestampMs);
    if (result.canceled) {
      this.totalOrdersCanceled += 1;
      this.orderToSymbol.delete(command.payload.orderId);
    }

    await this.options.commandLog.appendEvent({
      commandId: command.commandId,
      result,
    });

    this.emit('cancel_result', result);
    this.emit('orderbook', {
      symbol: targetSymbol,
      snapshot: book.getSnapshot(),
    });

    return result;
  }

  private getBook(symbol: string): OrderBook {
    const book = this.books.get(symbol);
    if (!book) {
      throw new Error(`Unsupported symbol: ${symbol}`);
    }
    return book;
  }

  private recordProcessingLatency(latencyMs: number): void {
    this.processingMetrics.lastLatencies.push(latencyMs);
    if (this.processingMetrics.lastLatencies.length > this.processingMetrics.maxSamples) {
      this.processingMetrics.lastLatencies.shift();
    }
  }

  private computeAvgLatency(): number {
    if (this.processingMetrics.lastLatencies.length === 0) {
      return 0;
    }

    const total = this.processingMetrics.lastLatencies.reduce((sum, latency) => sum + latency, 0);
    return total / this.processingMetrics.lastLatencies.length;
  }

  private computeP95Latency(): number {
    if (this.processingMetrics.lastLatencies.length === 0) {
      return 0;
    }

    const ordered = [...this.processingMetrics.lastLatencies].sort((left, right) => left - right);
    const p95Index = Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95));
    return ordered[p95Index] ?? 0;
  }
}

export type MatchingEngineCommand = EngineCommand;
