import { createServer, type Server as HttpServer } from 'node:http';

import express, { type NextFunction, type Request, type Response } from 'express';

import type { AppConfig } from './types/config.js';
import type { VirtualTransactionCommand, VirtualTransactionExecutionResult } from './types/engine.js';
import type { OrderRequest } from './types/order.js';
import { buildId } from './utils/id.js';
import { Logger } from './logging/logger.js';
import { CommandLog } from './logging/command-log.js';
import { MetricsRegistry } from './metrics/registry.js';
import { NetworkSimulator } from './network/network-simulator.js';
import { MockP2PBus } from './network/p2p-bus.js';
import { MatchingEngine } from './engine/matching-engine.js';
import { AnvilBridge } from './bridge/anvil-bridge.js';
import { CoreWriterActionBridge } from './bridge/corewriter-action-bridge.js';
import { VirtualMempool } from './bridge/virtual-mempool.js';
import { StateSynchronizer } from './sync/state-synchronizer.js';
import { RealtimeGateway } from './api/websocket.js';

const logger = new Logger('virtual-hypercore-app');

interface RequestRateState {
  count: number;
  resetAtMs: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    traceId?: string;
  }
}

export interface VirtualHyperCoreRuntime {
  app: express.Express;
  server: HttpServer;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createVirtualHyperCoreRuntime(config: AppConfig): VirtualHyperCoreRuntime {
  const metrics = new MetricsRegistry();
  const commandLog = new CommandLog(config.replay.commandLogFile);

  const engine = new MatchingEngine({
    config: config.engine,
    commandLog,
    metrics,
    randomSeed: config.network.seed,
  });

  const bridge = new AnvilBridge(config.bridge);
  const coreWriterActionBridge = config.coreWriterActionBridge?.enabled
    ? new CoreWriterActionBridge(bridge, engine, config.coreWriterActionBridge)
    : undefined;
  const networkSimulator = new NetworkSimulator(config.network);
  const p2pBus = new MockP2PBus(networkSimulator);

  const mempool = new VirtualMempool<VirtualTransactionCommand, VirtualTransactionExecutionResult>(
    config.mempool,
    async (payload) => executeVirtualCommand(payload, engine),
    bridge,
    (pendingCount) => {
      metrics.mempoolPendingTransactions.set(pendingCount);
    },
    config.network.seed + 1_000,
    (snapshot) => {
      if (wsGateway) {
        wsGateway.broadcast('mempool', '*', {
          channel: 'mempool',
          data: snapshot,
        });
      }
    }
  );

  p2pBus.registerHandler<OrderRequest, Awaited<ReturnType<typeof engine.submitOrder>>>(
    'order.submit',
    async (payload) => {
      return engine.submitOrder(payload);
    }
  );

  p2pBus.registerHandler<
    { orderId: string; userId?: string; symbol?: string },
    Awaited<ReturnType<typeof engine.cancelOrder>>
  >('order.cancel', async (payload) => {
    return engine.cancelOrder(payload.orderId, payload.userId, payload.symbol);
  });

  const stateSynchronizer = new StateSynchronizer(
    {
      syncFilePath: config.replay.stateSyncFile,
      intervalMs: 2_000,
    },
    engine,
    bridge,
    metrics
  );

  const app = express();
  const server = createServer(app);

  const wsGateway = new RealtimeGateway(server, config.wsPath, engine, mempool, metrics);

  const rateLimitState = new Map<string, RequestRateState>();

  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.traceId = getTraceId(req);
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const state = rateLimitState.get(key);

    if (!state || now >= state.resetAtMs) {
      rateLimitState.set(key, {
        count: 1,
        resetAtMs: now + config.rateLimit.windowMs,
      });
      next();
      return;
    }

    if (state.count >= config.rateLimit.maxRequests) {
      res.status(429).json({
        error: 'rate_limited',
        traceId: req.traceId,
      });
      return;
    }

    state.count += 1;
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
    });
  });

  app.post('/orders', async (req, res) => {
    const orderRequest = req.body as OrderRequest;

    try {
      const networkResult = await p2pBus.request<OrderRequest, Awaited<ReturnType<typeof engine.submitOrder>>>(
        'order.submit',
        orderRequest
      );

      if (!networkResult.delivered || !networkResult.result) {
        metrics.networkDroppedMessages.inc({ topic: 'order.submit' });
        res.status(503).json({
          error: 'order_dropped_by_network_simulation',
          latencyMs: networkResult.latencyMs,
          traceId: req.traceId,
        });
        return;
      }

      res.status(201).json({
        traceId: req.traceId,
        networkLatencyMs: networkResult.latencyMs,
        ...networkResult.result,
      });
    } catch (error) {
      logger.error('submit order failed', {
        traceId: req.traceId,
        error: String(error),
      });

      res.status(400).json({
        error: String(error),
        traceId: req.traceId,
      });
    }
  });

  app.delete('/orders/:id', async (req, res) => {
    try {
      const result = await p2pBus.request<
        { orderId: string; userId?: string; symbol?: string },
        Awaited<ReturnType<typeof engine.cancelOrder>>
      >('order.cancel', {
        orderId: req.params.id,
        userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
        symbol: typeof req.query.symbol === 'string' ? req.query.symbol : undefined,
      });

      if (!result.delivered || !result.result) {
        metrics.networkDroppedMessages.inc({ topic: 'order.cancel' });
        res.status(503).json({
          error: 'cancel_dropped_by_network_simulation',
          latencyMs: result.latencyMs,
          traceId: req.traceId,
        });
        return;
      }

      if (!result.result.canceled) {
        res.status(404).json({
          traceId: req.traceId,
          ...result.result,
        });
        return;
      }

      res.json({
        traceId: req.traceId,
        networkLatencyMs: result.latencyMs,
        ...result.result,
      });
    } catch (error) {
      res.status(400).json({
        error: String(error),
        traceId: req.traceId,
      });
    }
  });

  app.get('/orderbook', (req, res) => {
    const symbol = readSymbol(req, res);
    if (!symbol) {
      return;
    }

    const depth = readPositiveNumber(req.query.depth, config.engine.maxOrderBookDepth);
    try {
      const snapshot = engine.getSnapshot(symbol, depth);
      res.json(snapshot);
    } catch (error) {
      res.status(404).json({
        error: String(error),
      });
    }
  });

  app.get('/orderbook/depth', (req, res) => {
    const symbol = readSymbol(req, res);
    if (!symbol) {
      return;
    }

    const depth = readPositiveNumber(req.query.levels, 50);
    try {
      const snapshot = engine.getDepth(symbol, depth);
      res.json(snapshot);
    } catch (error) {
      res.status(404).json({
        error: String(error),
      });
    }
  });

  app.get('/trades', (req, res) => {
    const symbol = readSymbol(req, res);
    if (!symbol) {
      return;
    }

    const limit = readPositiveNumber(req.query.limit, 200);
    try {
      const trades = engine.getTrades(symbol, limit);
      res.json({
        symbol,
        trades,
      });
    } catch (error) {
      res.status(404).json({
        error: String(error),
      });
    }
  });

  app.get('/status', (_req, res) => {
    res.json({
      engine: engine.getStats(),
      mempoolPending: mempool.getPendingCount(),
      symbols: engine.getSupportedSymbols(),
      memory: process.memoryUsage(),
      uptimeSec: process.uptime(),
      nowMs: Date.now(),
    });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  });

  app.post('/bridge/sync', async (_req, res) => {
    if (!coreWriterActionBridge) {
      res.status(404).json({
        error: 'bridge_not_enabled',
      });
      return;
    }

    try {
      const result = await coreWriterActionBridge.syncOnce();
      res.json(result);
    } catch (error) {
      logger.error('bridge sync failed', {
        error: String(error),
      });
      res.status(500).json({
        error: 'bridge_sync_failed',
      });
    }
  });

  app.post('/rpc/exchange', async (req, res) => {
    try {
      const payload = req.body as {
        action?: unknown;
        gasPrice?: string | number;
        maxPriorityFeePerGas?: string | number;
        confirmations?: number;
        awaitConfirmation?: boolean;
      };

      const virtualCommand = parseExchangeAction(payload.action);
      const handle = mempool.submit(virtualCommand, {
        gasPrice: parseBigInt(payload.gasPrice, 1_000_000_000n),
        maxPriorityFeePerGas: parseBigInt(payload.maxPriorityFeePerGas, 100_000_000n),
        confirmations: payload.confirmations,
      });

      if (payload.awaitConfirmation) {
        const confirmed = await handle.confirmed;
        res.json(confirmed);
        return;
      }

      res.status(202).json({
        status: 'pending',
        txId: handle.txId,
      });
    } catch (error) {
      res.status(400).json({
        error: String(error),
      });
    }
  });

  app.post('/rpc/info', (req, res) => {
    const payload = req.body as {
      type?: string;
      txId?: string;
      symbol?: string;
      depth?: number;
      limit?: number;
    };

    switch (payload.type) {
      case 'transactionStatus': {
        if (!payload.txId) {
          res.status(400).json({ error: 'missing_tx_id' });
          return;
        }

        const tx = mempool.getTransaction(payload.txId);
        if (!tx) {
          res.status(404).json({ error: 'tx_not_found' });
          return;
        }

        res.json(tx);
        return;
      }

      case 'transactions': {
        res.json(mempool.listTransactions(payload.limit ?? 100));
        return;
      }

      case 'orderbook': {
        if (!payload.symbol) {
          res.status(400).json({ error: 'missing_symbol' });
          return;
        }

        res.json(engine.getSnapshot(payload.symbol, payload.depth));
        return;
      }

      case 'trades': {
        if (!payload.symbol) {
          res.status(400).json({ error: 'missing_symbol' });
          return;
        }

        res.json(engine.getTrades(payload.symbol, payload.limit));
        return;
      }

      case 'status': {
        res.json({
          engine: engine.getStats(),
          mempoolPending: mempool.getPendingCount(),
        });
        return;
      }

      default:
        res.status(400).json({ error: 'unsupported_info_type' });
    }
  });

  return {
    app,
    server,
    start: async () => {
      await stateSynchronizer.syncNow();
      mempool.start();
      stateSynchronizer.start();
      coreWriterActionBridge?.start();
      wsGateway.start();

      await new Promise<void>((resolve) => {
        server.listen(config.port, () => {
          logger.info('virtual hypercore started', {
            port: config.port,
            wsPath: config.wsPath,
          });
          resolve();
        });
      });
    },
    stop: async () => {
      mempool.stop();
      stateSynchronizer.stop();
      coreWriterActionBridge?.stop();
      wsGateway.stop();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function executeVirtualCommand(
  payload: VirtualTransactionCommand,
  engine: MatchingEngine
): Promise<VirtualTransactionExecutionResult> {
  if (payload.commandType === 'submit_order') {
    if (!payload.orderRequest) {
      throw new Error('missing_order_request');
    }

    const submitOrderResult = await engine.submitOrder(payload.orderRequest);
    return {
      kind: 'submit_order',
      submitOrderResult,
    };
  }

  if (!payload.cancelRequest) {
    throw new Error('missing_cancel_request');
  }

  const cancelOrderResult = await engine.cancelOrder(
    payload.cancelRequest.orderId,
    payload.cancelRequest.userId,
    payload.cancelRequest.symbol
  );

  return {
    kind: 'cancel_order',
    cancelOrderResult,
  };
}

function parseExchangeAction(action: unknown): VirtualTransactionCommand {
  if (!action || typeof action !== 'object') {
    throw new Error('invalid_action_payload');
  }

  const typedAction = action as {
    type?: string;
    order?: OrderRequest;
    cancel?: {
      orderId: string;
      userId?: string;
      symbol?: string;
    };
  };

  if (typedAction.type === 'order') {
    if (!typedAction.order) {
      throw new Error('missing_order_payload');
    }

    return {
      commandType: 'submit_order',
      orderRequest: typedAction.order,
    };
  }

  if (typedAction.type === 'cancel') {
    if (!typedAction.cancel) {
      throw new Error('missing_cancel_payload');
    }

    return {
      commandType: 'cancel_order',
      cancelRequest: typedAction.cancel,
    };
  }

  throw new Error('unsupported_exchange_action');
}

function parseBigInt(value: string | number | undefined, fallback: bigint): bigint {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === 'number') {
    return BigInt(Math.floor(value));
  }

  return BigInt(value);
}

function readPositiveNumber(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function getTraceId(req: Request): string {
  const headerValue = req.headers['x-trace-id'];
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }

  return buildId('trace');
}

function readSymbol(req: Request, res: Response): string | null {
  if (typeof req.query.symbol === 'string' && req.query.symbol.length > 0) {
    return req.query.symbol;
  }

  res.status(400).json({
    error: 'missing_symbol_query_param',
  });
  return null;
}
