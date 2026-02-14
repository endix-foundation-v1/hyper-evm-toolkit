# Virtual HyperCore Architecture

## Goals

- Provide a deterministic local HyperCore-like environment for integration tests
- Preserve key matching behaviors (price-time priority, TIF semantics, partial fills)
- Simulate network and block confirmation behavior without requiring production infrastructure
- Expose observable APIs (REST, WebSocket, Prometheus)

## Component Graph

```text
REST/WS Client
   |
   v
Express API (src/app.ts)
   |
   +--> MockP2PBus (src/network/p2p-bus.ts)
   |       |
   |       v
   |   NetworkSimulator (latency/jitter/loss)
   |
   +--> MatchingEngine (src/engine/matching-engine.ts)
   |       |
   |       v
   |   OrderBook per symbol (src/engine/order-book.ts)
   |       |
   |       +--> SkipList side indexes (src/engine/skip-list.ts)
   |       +--> FIFO queues per level (src/engine/price-level.ts)
   |
   +--> VirtualMempool (src/bridge/virtual-mempool.ts)
   |       |
   |       +--> optional AnvilBridge hook (src/bridge/anvil-bridge.ts)
   |
   +--> CommandLog JSONL (src/logging/command-log.ts)
   |
   +--> StateSynchronizer snapshots (src/sync/state-synchronizer.ts)
   |
   +--> MetricsRegistry /metrics (src/metrics/registry.ts)
```

## Matching Behavior

- **Order priority**: best price first, FIFO within each level
- **Level index**:
  - Asks: ascending skip list key (best ask is first)
  - Bids: negative-price skip list key (best bid is first)
- **Fill model**: piecewise matching against visible maker quantity
- **Partial fills**: order remains active until `remainingQuantity == 0`
- **Iceberg**:
  - only `displayedRemainingQuantity` is matchable
  - when displayed quantity is depleted and reserve remains, reserve replenishes and order is moved to level tail

## Order Types and TIF

- `limit`
- `market`
- TIF:
  - `GTC`: unfilled remainder posts to book
  - `IOC`: unfilled remainder expires
  - `FOK`: rejected if full fill is unavailable at submit time

## Self-Trade Prevention

Modes:

- `none`
- `cancel_newest`: incoming taker canceled
- `cancel_oldest`: resting maker canceled
- `cancel_both`: both orders canceled

## Virtual Mempool and Confirmations

- Pending transactions are sorted by effective gas (`gasPrice + maxPriorityFeePerGas`)
- Inclusion occurs in block ticks (`BLOCK_INTERVAL_MS`)
- Per-block inclusion capped by `MAX_TX_PER_BLOCK`
- Confirmation follows:
  - minimum confirmations threshold
  - probabilistic confirmation (`CONFIRMATION_PROBABILITY_PER_BLOCK`)

## Determinism Strategy

- Seeded PRNG for network and mempool behavior
- Deterministic price-level ordering and FIFO queues
- Append-only command log and replay support
- Periodic state snapshots with sequence references

## Performance Strategy

- O(1) best level lookup
- O(log n) level insert/remove via skip list
- O(1) order lookup by ID map for cancel
- Async API and websocket fanout
- Benchmark harness in `src/benchmark.ts`
