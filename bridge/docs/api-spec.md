# API Specification

## REST

### `POST /orders`

Submit a limit or market order directly through the offchain CLOB path.

Request body:

```json
{
  "id": "optional-order-id",
  "symbol": "ETH-USD",
  "userId": "user-1",
  "side": "buy",
  "kind": "limit",
  "quantity": 10,
  "price": 3000,
  "timeInForce": "GTC",
  "icebergDisplayQuantity": 2,
  "selfTradePrevention": "none"
}
```

Response:

- `201` with submit result and matching trades
- `503` when dropped by network simulation

### `DELETE /orders/:id`

Cancel a resting order.

Query params:

- `userId` (optional ownership check)
- `symbol` (optional hint)

### `GET /orderbook`

Query params:

- `symbol` (required)
- `depth` (optional)

Returns full snapshot with bids/asks.

### `GET /orderbook/depth`

Query params:

- `symbol` (required)
- `levels` (optional)

Returns aggregated depth only.

### `GET /trades`

Query params:

- `symbol` (required)
- `limit` (optional)

Returns recent executed trades.

### `GET /status`

Returns runtime health, memory, stats, and active symbols.

### `GET /health`

Liveness endpoint.

### `GET /metrics`

Prometheus scrape endpoint.

## HyperCore-Style RPC

### `POST /rpc/exchange`

Submit virtual transaction for order or cancel action.

Order request:

```json
{
  "action": {
    "type": "order",
    "order": {
      "symbol": "ETH-USD",
      "userId": "user-1",
      "side": "buy",
      "kind": "limit",
      "quantity": 5,
      "price": 2990,
      "timeInForce": "GTC"
    }
  },
  "gasPrice": "1000000000",
  "maxPriorityFeePerGas": "100000000",
  "confirmations": 2,
  "awaitConfirmation": false
}
```

Cancel request:

```json
{
  "action": {
    "type": "cancel",
    "cancel": {
      "orderId": "ord_123",
      "userId": "user-1",
      "symbol": "ETH-USD"
    }
  }
}
```

### `POST /rpc/info`

Supported `type` values:

- `transactionStatus` (`txId` required)
- `transactions`
- `orderbook` (`symbol` required)
- `trades` (`symbol` required)
- `status`

## WebSocket

Path: `/ws` (configurable)

### Subscribe

```json
{ "method": "subscribe", "channel": "trades", "symbol": "ETH-USD" }
```

Channels:

- `orderbook` (symbol or `*`)
- `trades` (symbol or `*`)
- `status`
- `mempool`

### Unsubscribe

```json
{ "method": "unsubscribe", "channel": "trades", "symbol": "ETH-USD" }
```

### Ping

```json
{ "method": "ping" }
```

Response:

```json
{ "channel": "pong", "data": { "ts": 1739441122334 } }
```
