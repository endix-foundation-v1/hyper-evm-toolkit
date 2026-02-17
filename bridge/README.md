# Virtual HyperCore

Deterministic offchain HyperCore simulation service for local development and Anvil-based integration testing.

## What It Provides

- Offchain CLOB matching engine with price-time priority
- Limit and market orders
- IOC, FOK, and GTC time-in-force handling
- Cancel by order ID
- Iceberg order support (visible + reserve quantities)
- Self-trade prevention modes (`none`, `cancel_newest`, `cancel_oldest`, `cancel_both`)
- REST and WebSocket APIs for order book and trade streams
- Virtual mempool with gas-priority ordering and confirmation simulation
- Optional Anvil bridge hooks
- Command log + deterministic replay support
- Prometheus metrics endpoint
- Structured JSON logs with trace IDs

## Architecture

### 1) Matching Core

- `src/engine/order-book.ts`
  - Two-sided order book with price-level indexing
  - FIFO queue per price level
  - Partial fills and iceberg replenishment
- `src/engine/skip-list.ts`
  - Numeric skip list for price-level index
  - O(log n) insert/remove and O(1) best level access
- `src/engine/matching-engine.ts`
  - Multi-symbol orchestration
  - Stats tracking and command replay

### 2) Networking + Propagation

- `src/network/network-simulator.ts`
  - Simulated latency, jitter, and packet loss
- `src/network/p2p-bus.ts`
  - Mock P2P request/response propagation layer

### 3) Virtual Chain Interface

- `src/bridge/virtual-mempool.ts`
  - Gas-priority tx ordering
  - Block-interval inclusion
  - Probabilistic confirmation model
- `src/bridge/anvil-bridge.ts`
  - Optional `evm_mine` and noop tx hooks into Anvil

### 4) API + Observability

- `src/app.ts`
  - REST endpoints
  - HyperCore-style RPC endpoints
  - Request rate limiting
- `src/api/websocket.ts`
  - Real-time subscriptions for order book, trades, status, and mempool
- `src/metrics/registry.ts`
  - Prometheus counters, gauges, and latency histograms

### 5) Determinism + Sync

- `src/logging/command-log.ts`
  - JSONL command/event append-only log
- `src/sync/state-synchronizer.ts`
  - Periodic state snapshot write (`state-sync.json`)

## API

### REST Endpoints

- `POST /orders`
- `DELETE /orders/:id`
- `GET /orderbook?symbol=ETH-USD&depth=50`
- `GET /orderbook/depth?symbol=ETH-USD&levels=50`
- `GET /trades?symbol=ETH-USD&limit=200`
- `GET /status`
- `GET /health`
- `GET /metrics`

### HyperCore-Style RPC Endpoints

- `POST /rpc/exchange`
  - Submit virtual transactions for order/cancel actions
  - Supports gas and priority fee parameters
- `POST /rpc/info`
  - Query transaction status, snapshots, trades, and runtime status

### WebSocket

- Path: configured by `WS_PATH` (default: `/ws`)
- Subscribe:

```json
{ "method": "subscribe", "channel": "orderbook", "symbol": "ETH-USD" }
```

- Unsubscribe:

```json
{ "method": "unsubscribe", "channel": "orderbook", "symbol": "ETH-USD" }
```

- Ping:

```json
{ "method": "ping" }
```

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

## Benchmark

```bash
npm run benchmark
```

The benchmark prints throughput and latency percentile output as JSON.

## Test + Validate

```bash
npm run test
npm run typecheck
npm run build
```

## Environment Configuration

See `.env.example` for all values. Main groups:

- Engine constraints: tick size, lot size, symbols, depth
- Network simulation: latency, jitter, packet loss, deterministic seed
- Mempool simulation: block interval, max tx per block, confirmation probability
- Anvil bridge: RPC URL, chain ID, optional private key + sink address
- Replay and state files: command log and state sync output paths

## Deterministic Testing Notes

- Price level ordering is deterministic for equal prices by FIFO insertion sequence
- Network simulation uses seeded PRNG
- Mempool ordering uses deterministic effective gas ranking and submission time tie-break
- Command replay re-applies recorded commands in order
