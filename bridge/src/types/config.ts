export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface NetworkSimulationConfig {
  baseLatencyMs: number;
  jitterMs: number;
  packetLossRate: number;
  seed: number;
}

export interface MempoolConfig {
  blockIntervalMs: number;
  maxTransactionsPerBlock: number;
  defaultConfirmations: number;
  confirmationProbabilityPerBlock: number;
}

export interface AnvilBridgeConfig {
  rpcUrl: string;
  chainId: number;
  privateKey?: string;
  sinkAddress?: `0x${string}`;
}

export interface CoreWriterActionBridgeConfig {
  enabled: boolean;
  mode: 'manual' | 'interval';
  intervalMs: number;
  coreWriterAddress: `0x${string}`;
  hyperCoreAddress: `0x${string}`;
  marketMap: Record<string, string>;
  perpMarketMap?: Record<string, string>;
}

export interface ReplayConfig {
  dataDir: string;
  commandLogFile: string;
  stateSyncFile: string;
}

export interface EngineConfig {
  symbols: string[];
  tickSize: number;
  lotSize: number;
  minOrderQuantity: number;
  maxOrderBookDepth: number;
}

export interface AppConfig {
  port: number;
  wsPath: string;
  nodeEnv: string;
  engine: EngineConfig;
  rateLimit: RateLimitConfig;
  network: NetworkSimulationConfig;
  mempool: MempoolConfig;
  bridge: AnvilBridgeConfig;
  coreWriterActionBridge?: CoreWriterActionBridgeConfig;
  replay: ReplayConfig;
}
