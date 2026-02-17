import type { Server as HttpServer } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

import type { MatchingEngine } from '../engine/matching-engine.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { VirtualMempool, VirtualTransactionSnapshot } from '../bridge/virtual-mempool.js';
import type { VirtualTransactionCommand, VirtualTransactionExecutionResult } from '../types/engine.js';
import { Logger } from '../logging/logger.js';

const logger = new Logger('websocket-gateway');

interface SubscriptionMessage {
  method: 'subscribe' | 'unsubscribe' | 'ping';
  channel?: 'orderbook' | 'trades' | 'status' | 'mempool';
  symbol?: string;
}

type SubscriptionKey = `${string}:${string}`;

function buildSubscriptionKey(channel: string, symbol = '*'): SubscriptionKey {
  return `${channel}:${symbol}`;
}

export class RealtimeGateway {
  private readonly wsServer: WebSocketServer;
  private readonly clientSubscriptions = new Map<WebSocket, Set<SubscriptionKey>>();
  private statusInterval: NodeJS.Timeout | null = null;

  constructor(
    server: HttpServer,
    path: string,
    private readonly engine: MatchingEngine,
    private readonly mempool: VirtualMempool<VirtualTransactionCommand, VirtualTransactionExecutionResult>,
    private readonly metrics: MetricsRegistry
  ) {
    this.wsServer = new WebSocketServer({ server, path });

    this.wsServer.on('connection', (socket) => {
      this.onConnection(socket);
    });

    this.engine.on('trade', (trade) => {
      this.broadcast('trades', trade.symbol, { channel: 'trades', data: trade });
    });

    this.engine.on('orderbook', ({ symbol, snapshot }) => {
      this.broadcast('orderbook', symbol, { channel: 'orderbook', symbol, data: snapshot });
    });
  }

  start(): void {
    if (this.statusInterval) {
      return;
    }

    this.statusInterval = setInterval(() => {
      const statusPayload = {
        channel: 'status',
        data: {
          engine: this.engine.getStats(),
          mempoolPending: this.mempool.getPendingCount(),
          timestampMs: Date.now(),
        },
      };
      this.broadcast('status', '*', statusPayload);
    }, 1000);
  }

  stop(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    this.wsServer.close();
  }

  private onConnection(socket: WebSocket): void {
    this.clientSubscriptions.set(socket, new Set());
    this.metrics.wsConnections.inc();

    socket.on('message', (data) => {
      this.onMessage(socket, data);
    });

    socket.on('close', () => {
      this.clientSubscriptions.delete(socket);
      this.metrics.wsConnections.dec();
    });

    socket.send(
      JSON.stringify({
        channel: 'system',
        data: {
          message: 'connected',
        },
      })
    );
  }

  private onMessage(socket: WebSocket, data: WebSocket.RawData): void {
    let message: SubscriptionMessage;
    try {
      message = JSON.parse(data.toString()) as SubscriptionMessage;
    } catch {
      socket.send(JSON.stringify({ channel: 'error', data: { error: 'invalid_json' } }));
      return;
    }

    if (message.method === 'ping') {
      socket.send(JSON.stringify({ channel: 'pong', data: { ts: Date.now() } }));
      return;
    }

    if (!message.channel) {
      socket.send(JSON.stringify({ channel: 'error', data: { error: 'missing_channel' } }));
      return;
    }

    const symbol = message.symbol ?? '*';
    const key = buildSubscriptionKey(message.channel, symbol);
    const subscriptions = this.clientSubscriptions.get(socket);
    if (!subscriptions) {
      return;
    }

    if (message.method === 'subscribe') {
      subscriptions.add(key);
      socket.send(
        JSON.stringify({
          channel: 'subscriptionResponse',
          data: {
            method: 'subscribe',
            channel: message.channel,
            symbol,
          },
        })
      );

      if (message.channel === 'orderbook' && symbol !== '*') {
        try {
          const snapshot = this.engine.getSnapshot(symbol, 50);
          socket.send(
            JSON.stringify({
              channel: 'orderbook',
              symbol,
              isSnapshot: true,
              data: snapshot,
            })
          );
        } catch (error) {
          logger.warn('could not send orderbook snapshot', {
            symbol,
            error: String(error),
          });
        }
      }

      if (message.channel === 'mempool') {
        const latest = this.mempool
          .listTransactions(100)
          .map((tx: VirtualTransactionSnapshot<VirtualTransactionExecutionResult>) => tx);
        socket.send(
          JSON.stringify({
            channel: 'mempool',
            isSnapshot: true,
            data: latest,
          })
        );
      }

      return;
    }

    subscriptions.delete(key);
    socket.send(
      JSON.stringify({
        channel: 'subscriptionResponse',
        data: {
          method: 'unsubscribe',
          channel: message.channel,
          symbol,
        },
      })
    );
  }

  broadcast(channel: string, symbol: string, payload: unknown): void {
    for (const [socket, subscriptions] of this.clientSubscriptions.entries()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      const symbolSpecific = buildSubscriptionKey(channel, symbol);
      const wildcard = buildSubscriptionKey(channel, '*');
      if (!subscriptions.has(symbolSpecific) && !subscriptions.has(wildcard)) {
        continue;
      }

      socket.send(JSON.stringify(payload));
    }
  }
}
