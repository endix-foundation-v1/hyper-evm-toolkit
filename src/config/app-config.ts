import 'dotenv/config';

import type { AppConfig } from '../types/config.js';

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readNumber(name: string, fallback?: number): number {
  const raw = process.env[name] ?? (fallback === undefined ? undefined : String(fallback));
  if (raw === undefined) {
    throw new Error(`Missing required numeric environment variable: ${name}`);
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${raw}`);
  }

  return parsed;
}

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }

  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseMarketMap(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) {
      continue;
    }

    const [spotIndex, symbol] = trimmedPair.split(':').map((value) => value.trim());
    if (!spotIndex || !symbol) {
      continue;
    }

    map[spotIndex] = symbol;
  }

  return map;
}

export function loadAppConfig(): AppConfig {
  const symbols = readEnv('SYMBOLS', 'ETH-USD,BTC-USD,SOL-USD')
    .split(',')
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0);

  const coreWriterBridgeEnabled = readBoolean('CORE_WRITER_BRIDGE_ENABLED', false);

  return {
    port: readNumber('PORT', 3010),
    wsPath: readEnv('WS_PATH', '/ws'),
    nodeEnv: readEnv('NODE_ENV', 'development'),
    engine: {
      symbols,
      tickSize: readNumber('DEFAULT_TICK_SIZE', 1),
      lotSize: readNumber('DEFAULT_LOT_SIZE', 1),
      minOrderQuantity: readNumber('MIN_ORDER_QUANTITY', 1),
      maxOrderBookDepth: readNumber('MAX_ORDERBOOK_DEPTH', 500),
    },
    rateLimit: {
      windowMs: readNumber('API_RATE_LIMIT_WINDOW_MS', 60_000),
      maxRequests: readNumber('API_RATE_LIMIT_MAX_REQUESTS', 10_000),
    },
    network: {
      baseLatencyMs: readNumber('NETWORK_BASE_LATENCY_MS', 5),
      jitterMs: readNumber('NETWORK_JITTER_MS', 2),
      packetLossRate: readNumber('NETWORK_PACKET_LOSS_RATE', 0),
      seed: readNumber('NETWORK_RANDOM_SEED', 42),
    },
    mempool: {
      blockIntervalMs: readNumber('BLOCK_INTERVAL_MS', 250),
      maxTransactionsPerBlock: readNumber('MAX_TX_PER_BLOCK', 2000),
      defaultConfirmations: readNumber('DEFAULT_CONFIRMATIONS', 2),
      confirmationProbabilityPerBlock: readNumber('CONFIRMATION_PROBABILITY_PER_BLOCK', 0.95),
    },
    bridge: {
      rpcUrl: readEnv('ANVIL_RPC_URL', 'http://127.0.0.1:8545'),
      chainId: readNumber('ANVIL_CHAIN_ID', 31337),
      privateKey: readOptional('ANVIL_PRIVATE_KEY'),
      sinkAddress: readOptional('ANVIL_SINK_ADDRESS') as `0x${string}` | undefined,
    },
    coreWriterActionBridge: coreWriterBridgeEnabled
      ? {
          enabled: true,
          mode: readEnv('CORE_WRITER_BRIDGE_MODE', 'manual') === 'interval' ? 'interval' : 'manual',
          intervalMs: readNumber('CORE_WRITER_BRIDGE_INTERVAL_MS', 250),
          coreWriterAddress: readEnv(
            'CORE_WRITER_ADDRESS',
            '0x3333333333333333333333333333333333333333'
          ) as `0x${string}`,
          hyperCoreAddress: readEnv(
            'HYPER_CORE_ADDRESS',
            '0x9999999999999999999999999999999999999999'
          ) as `0x${string}`,
          marketMap: parseMarketMap(readOptional('CORE_WRITER_BRIDGE_MARKET_MAP')),
        }
      : undefined,
    replay: {
      dataDir: readEnv('DATA_DIR', './data'),
      commandLogFile: readEnv('COMMAND_LOG_FILE', './data/command-log.jsonl'),
      stateSyncFile: readEnv('STATE_SYNC_FILE', './data/state-sync.json'),
    },
  };
}
