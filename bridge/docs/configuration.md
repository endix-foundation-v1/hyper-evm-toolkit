# Configuration Reference

All settings are environment-driven. See `.env.example`.

## Core Runtime

- `PORT`: HTTP server port
- `WS_PATH`: websocket path
- `NODE_ENV`: runtime mode
- `SYMBOLS`: comma-separated symbol universe

## Matching Constraints

- `DEFAULT_TICK_SIZE`: valid price increment
- `DEFAULT_LOT_SIZE`: valid quantity increment
- `MIN_ORDER_QUANTITY`: minimum allowed order size
- `MAX_ORDERBOOK_DEPTH`: max depth returned by default

## Network Simulation

- `NETWORK_BASE_LATENCY_MS`: base one-way propagation latency
- `NETWORK_JITTER_MS`: random latency jitter (+/-)
- `NETWORK_PACKET_LOSS_RATE`: drop probability in `[0,1]`
- `NETWORK_RANDOM_SEED`: deterministic seed for simulation

## Virtual Block / Confirmation Simulation

- `BLOCK_INTERVAL_MS`: virtual block cadence
- `MAX_TX_PER_BLOCK`: cap on included txs per block
- `DEFAULT_CONFIRMATIONS`: minimum confirmation requirement
- `CONFIRMATION_PROBABILITY_PER_BLOCK`: confirmation probability after minimum confirmations

## Anvil Bridge

- `ANVIL_RPC_URL`: local anvil RPC endpoint
- `ANVIL_CHAIN_ID`: chain ID (typically `31337`)
- `ANVIL_PRIVATE_KEY`: optional key for noop tx hooks
- `ANVIL_SINK_ADDRESS`: optional tx target address for noop tx hooks

## Replay / Persistence

- `DATA_DIR`: output directory for runtime files
- `COMMAND_LOG_FILE`: append-only JSONL command log path
- `STATE_SYNC_FILE`: periodic sync state output path

## API Rate Limits

- `API_RATE_LIMIT_WINDOW_MS`: in-memory rate window
- `API_RATE_LIMIT_MAX_REQUESTS`: max requests per key per window
