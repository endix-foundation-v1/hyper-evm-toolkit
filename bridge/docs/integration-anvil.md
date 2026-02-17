# Anvil Integration Guide

## Purpose

This service is offchain-first. It can run independently and optionally synchronize with a local Anvil chain for block-awareness and transaction hook simulation.

## 1) Start Anvil

From `dev/` root:

```bash
./scripts/dev.sh
```

Or standalone:

```bash
anvil --port 8545
```

## 2) Configure Bridge

Set in `.env`:

```bash
ANVIL_RPC_URL=http://127.0.0.1:8545
ANVIL_CHAIN_ID=31337
```

Optional noop tx hooks:

```bash
ANVIL_PRIVATE_KEY=0x...
ANVIL_SINK_ADDRESS=0x...
```

If key/address are unset, the bridge still works for block reads and `evm_mine` attempts.

## 3) Run Service

```bash
npm run dev
```

## 4) Verify Block Sync

- Call `GET /status` and ensure runtime is healthy
- Check state sync output file (`STATE_SYNC_FILE`) for `anvilBlockNumber`

## 5) Test Virtual Transaction Path

Submit via RPC endpoint:

```bash
curl -X POST http://localhost:3010/rpc/exchange \
  -H 'content-type: application/json' \
  -d '{
    "action": {
      "type": "order",
      "order": {
        "symbol": "ETH-USD",
        "userId": "alice",
        "side": "buy",
        "kind": "limit",
        "quantity": 2,
        "price": 3000,
        "timeInForce": "GTC"
      }
    },
    "gasPrice": "1000000000",
    "maxPriorityFeePerGas": "100000000"
  }'
```

Then query status:

```bash
curl -X POST http://localhost:3010/rpc/info \
  -H 'content-type: application/json' \
  -d '{"type":"transactionStatus", "txId":"<tx-id>"}'
```

## Notes

- Matching remains fully offchain and deterministic.
- Anvil integration is intentionally modular to support both:
  - pure local simulation
  - local chain-aware development workflows
