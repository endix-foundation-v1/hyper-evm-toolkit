# hyper-evm-toolkit

![License](https://img.shields.io/github/license/endix-foundation-v1/hyper-evm-toolkit)
![Solidity](https://img.shields.io/badge/solidity-%3E%3D0.8.0-blue)
![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5.0-blue)

## The all-in-one toolkit for building and testing on HyperEVM

A unified framework that combines **Solidity libraries** for HyperEVM development with a **three-tier testing system** for HyperCore interactions. Install via `forge install` (Solidity only) or `npm install` (full toolkit with Level 3 bridge).

### What's in the box

| Layer | Language | Purpose |
|-------|----------|---------|
| `src/` | Solidity | CoreWriterLib, PrecompileLib, TokenRegistry — production libraries |
| `test/simulation/` | Solidity | Level 1 & 2 — local HyperCore simulation for Foundry tests |
| `bridge/` | TypeScript | Level 3 — realistic CLOB matching engine with async settlement |

---

## Installation

### Foundry (Solidity Level 1 & 2)

```sh
forge install endix-foundation-v1/hyper-evm-toolkit
echo "@hyper-evm-toolkit/=lib/hyper-evm-toolkit/" >> remappings.txt
```

### npm (Full toolkit with Level 3 bridge)

```sh
npm install hyper-evm-toolkit
```

---

## Key Components

### CoreWriterLib

Functions to call `CoreWriter` actions, with helpers to:

* Bridge tokens to/from Core
* Convert spot token amount representation between EVM and Core (wei) decimals

### PrecompileLib

Query native read precompiles, including functions that accept EVM token addresses directly (no manual token index management).

### TokenRegistry

On-chain mapping from EVM contract addresses to HyperCore token indices, populated trustlessly via precompile lookups. See [`TokenRegistry.sol`](./src/registry/TokenRegistry.sol).

### Virtual HyperCore (VHC) Testing Framework

A three-tier simulation engine for HyperCore interactions. Tests run in seconds locally — no testnet deployments needed.

---

## Virtual HyperCore (VHC) Testing Guide

### Overview

VHC is a local simulation of HyperCore that runs entirely inside Foundry. It replaces the real HyperCore precompiles, `CoreWriter`, and `CoreDepositWallet` with simulated contracts, enabling fast, deterministic tests for any protocol that interacts with Hyperliquid's L1.

**How it works:** `CoreSimulatorLib.init()` etches simulated bytecode at the canonical system addresses (`0x3333...` for CoreWriter, `0x9999...` for HyperCore, `0x0800`–`0x0810` for precompiles). Your contracts call `CoreWriterLib` and `PrecompileLib` as normal — they hit the simulated contracts instead of real precompiles.

All order settlement flows through dedicated bridge functions:
- **Spot:** `applyBridgeActionResult()` — updates spot balances, deducts fees, emits `BridgeActionApplied`
- **Perps:** `applyPerpBridgeActionResult()` — updates perp positions (open/increase/close with PnL), deducts fees, emits `PerpBridgeActionApplied`

Both paths mirror how the real Hyperliquid bridge settles orders from EVM.

```
Your Contract
    │
    ├─ CoreWriterLib.placeLimitOrder()   ──►  CoreWriterSim (ring buffer queue)
    ├─ PrecompileLib.spotBalance()       ──►  PrecompileSim (reads from HyperCore state)
    ├─ PrecompileLib.perpBalance()       ──►  PrecompileSim (reads perp positions)
    │
    └─ nextBlock()                       ──►  CoreSimulatorLib
                                                ├─ Advance block number + timestamp
                                                ├─ Check deferred spot + perp limit orders
                                                ├─ Auto-apply queued spot orders via applyBridgeActionResult()
                                                └─ Auto-apply queued perp orders via applyPerpBridgeActionResult()
```

### Two Runtime Modes

| Mode | Activation | Behavior |
|------|-----------|----------|
| **Offline** (default) | `forge test` | Pure local simulation. Zero RPC calls. All state is mocked. Fast. |
| **Fork** | `FORK_MODE=true forge test` | Forks real Hyperliquid chain state. Falls back to real chain data for unmocked state. |

### Three Testing Tiers

| Tier | Settlement Method | Learning Curve | Best For |
|------|-------------------|----------------|----------|
| **Level 1 — Auto-Apply** | `nextBlock()` auto-fills all queued spot and perp orders at the limit price | Zero | Most protocol tests |
| **Level 2 — Explicit Settlement** | `consumeAllAndReturn()` + manual `applyFilledSpotOrder()`, `applyFilledPerpOrder()`, etc. | Moderate | Testing rejection, partial fill, error handling |
| **Level 3 — Realistic Bridge** | TypeScript bridge with real CLOB matching engine for both spot and perps ([`bridge/`](./bridge/)) | Advanced | Production-grade simulation with realistic async settlement |

---

### Getting Started

All VHC tests inherit from `BaseSimulatorTest`:

```solidity
import {BaseSimulatorTest} from "@hyper-evm-toolkit/test/BaseSimulatorTest.sol";
import {CoreSimulatorLib} from "@hyper-evm-toolkit/test/simulation/CoreSimulatorLib.sol";

contract MyProtocolTest is BaseSimulatorTest {
    address alice = makeAddr("alice");

    function setUp() public override {
        super.setUp(); // Initializes HyperCore, CoreWriter, precompiles

        CoreSimulatorLib.forceAccountActivation(alice);
        CoreSimulatorLib.forceSpotBalance(alice, 0, 1_000_000e8); // 1M USDC
    }
}
```

---

### Level 1: Auto-Apply

Place orders, call `nextBlock()`, balances update automatically.

```solidity
function test_spotBuy() public {
    vm.prank(alice);
    CoreWriterLib.placeLimitOrder(
        uint32(10000 + SPOT_INDEX), true, uint64(100e8), uint64(2e8),
        false, HLConstants.LIMIT_ORDER_TIF_GTC, uint128(42)
    );

    // Auto-fills all queued orders via applyBridgeActionResult()
    CoreSimulatorLib.nextBlock();

    // Balances updated: base credited, quote debited (including 0.04% fee)
    assertGt(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore);
}
```

Orders with limit prices that don't match the current spot price are **deferred** and re-checked on subsequent `nextBlock()` calls.

#### Perp Orders (Level 1)

Perp orders work the same way — place the order, call `nextBlock()`, positions update automatically.

```solidity
function test_perpLong() public {
    // Initialize perp account with USDC margin
    CoreSimulatorLib.forceAccountActivation(alice);
    CoreSimulatorLib.forceSpotBalance(alice, 0, 1_000_000e8); // USDC for margin

    // Set mark price for the perp asset
    CoreSimulatorLib.setMarkPx(PERP_ASSET, 20e8); // $20 mark price

    vm.prank(alice);
    CoreWriterLib.placeLimitOrder(
        uint32(PERP_ASSET), true, uint64(20e8), uint64(100e8),
        false, HLConstants.LIMIT_ORDER_TIF_GTC, uint128(42)
    );

    // Auto-fills perp order via applyPerpBridgeActionResult()
    CoreSimulatorLib.nextBlock();

    // Position opened: sz > 0, avgEntryPrice set, fee deducted
    RealL1Read.PerpBalance memory perp = PrecompileLib.perpBalance(alice, PERP_ASSET);
    assertGt(perp.position.sz, 0);
}
```

**Perp mechanics:**
- Asset IDs: `< 10000` or `>= 100000` (e.g., HYPE perp = 150)
- Size is scaled from 8-decimal CoreWriter format to the asset's `szDecimals` (HYPE=2, BTC=5, ETH=4)
- Fees: `notional × perpMakerFee / FEE_DENOMINATOR` (default 0.015%)
- PnL: Realized on close/reduce — computed from `avgEntryPrice` vs execution price
- Deferred orders: Re-checked on `nextBlock()` when mark price matches limit

---

### Level 2: Explicit Settlement

Consume queued actions and apply outcomes manually for full control.

```solidity
import {CoreWriterSim} from "@hyper-evm-toolkit/test/simulation/CoreWriterSim.sol";

function test_rejectedOrder() public {
    vm.prank(alice);
    CoreWriterLib.placeLimitOrder(/* ... */);

    // Drain the queue — does NOT execute orders
    CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.consumeAllAndReturn();

    // Apply with explicit outcome
    CoreSimulatorLib.applyRejectedAction(
        actions[0], uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE)
    );
}

function test_partialFill() public {
    vm.prank(alice);
    CoreWriterLib.placeLimitOrder(/* size=5e8 */);

    CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.consumeAllAndReturn();
    CoreSimulatorLib.applyPartialFilledSpotOrder(actions[0], uint64(2e8), uint64(95e8));
}
```

**Available Level 2 helpers — Spot:**

| Function | Outcome | Balance Effect |
|----------|---------|----------------|
| `applyFilledSpotOrder(action, executionPrice)` | FILLED | Full balance update with fees |
| `applyPartialFilledSpotOrder(action, filledAmount, executionPrice)` | PARTIAL_FILLED | Partial balance update |
| `applyRejectedAction(action, reason)` | REJECTED | No balance change |
| `applyErrorAction(action, reason)` | ERROR | No balance change |

**Available Level 2 helpers — Perps:**

| Function | Outcome | Position Effect |
|----------|---------|-----------------|
| `applyFilledPerpOrder(action, executionPrice)` | FILLED | Full position update with fees + PnL |
| `applyPartialFilledPerpOrder(action, filledSz, executionPrice)` | PARTIAL_FILLED | Partial position update |
| `applyRejectedPerpAction(action, reason)` | REJECTED | No position change |
| `applyErrorPerpAction(action, reason)` | ERROR | No position change |

```solidity
function test_level2_rejectedPerpOrder() public {
    vm.prank(alice);
    CoreWriterLib.placeLimitOrder(uint32(PERP_ASSET), /* ... */);

    CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.consumeAllAndReturn();
    CoreSimulatorLib.applyRejectedPerpAction(
        actions[0], uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE)
    );
}
```

Level 1 and Level 2 can be mixed freely in the same test, for both spot and perp orders.

---

### Level 3: Realistic Bridge

The [`bridge/`](./bridge/) directory contains a full TypeScript CLOB matching engine that provides realistic async settlement for both **spot and perp** orders. It runs as a sidecar process alongside Anvil, polling the CoreWriterSim's ring buffer for queued actions, running them through a real order book, and settling via `applyBridgeActionResult()` (spot) or `applyPerpBridgeActionResult()` (perps).

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your Contract   │────►│  CoreWriterSim   │────►│  TS Bridge      │
│  (Foundry test)  │     │  (ring buffer)   │     │  (CLOB engine)  │
│                  │◄────│                  │◄────│                 │
│  balances update │     │  applyBridge...  │     │  match result   │
│  positions update│     │  applyPerpBridge │     │  (spot + perps) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

Features:
- Price-time priority CLOB matching engine (asset-agnostic — handles both spot and perp symbols)
- Limit, market, IOC, FOK, GTC order support
- Iceberg orders with reserve quantities
- Self-trade prevention
- Automatic asset classification: spot (`10000 ≤ asset < 100000`) vs perp (`asset < 10000` or `asset ≥ 100000`)
- Perp orders routed to `applyPerpBridgeActionResult()` — no spot balance check (margin tracked on L1)
- Deterministic replay via command log
- WebSocket real-time order book / trade streams

#### Supported actions in Level 3 bridge

The TypeScript bridge currently processes these CoreWriter action kinds:

- `LIMIT_ORDER_ACTION` (spot + perp)
- `CANCEL_ORDER_BY_OID_ACTION`
- `CANCEL_ORDER_BY_CLOID_ACTION`
- `SPOT_SEND_ACTION`

For settlement, it uses:

- `applyBridgeActionResult()` for spot orders
- `applyPerpBridgeActionResult()` for perp orders

#### Unsupported action kinds

Action kinds outside the list above are marked as unsupported by the bridge. For tests that require those flows, use **Level 1** or **Level 2** simulation helpers directly.

Typical examples include vault transfer, staking/delegation actions, USD class transfer, builder-fee approval, API wallet updates, and contract finalization actions.

**Bridge configuration** (spot + perps):

```typescript
coreWriterActionBridge: {
  enabled: true,
  mode: 'interval',
  intervalMs: 100,
  coreWriterAddress: '0x3333333333333333333333333333333333333333',
  hyperCoreAddress: '0x9999999999999999999999999999999999999999',
  marketMap: { '1': 'ETH-USD' },          // spotIndex → engine symbol
  perpMarketMap: { '150': 'HYPE-PERP' },  // perpAsset → engine symbol
}
```

See [`bridge/README.md`](./bridge/README.md) for full documentation.

```bash
cd bridge && npm install && npm run dev
```

---

### Fee Settlement

Fees are computed inside the bridge settlement functions:

**Spot fees** (inside `applyBridgeActionResult()`):

```
quoteAmount = (filledAmount × executionPrice) / 1e8
feeAmount   = (quoteAmount × spotMakerFee) / FEE_DENOMINATOR
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `spotMakerFee` | `400` | 0.04% (4 bps) |
| `FEE_DENOMINATOR` | `1e6` | Fee denominator |

```solidity
CoreSimulatorLib.setSpotMakerFee(1000); // 0.1%
CoreSimulatorLib.setSpotMakerFee(0);    // Disable fees
```

**Perp fees** (inside `applyPerpBridgeActionResult()`):

```
notional  = filledSz × executionPrice / 1e8
feeAmount = notional × perpMakerFee / FEE_DENOMINATOR
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `perpMakerFee` | `150` | 0.015% (1.5 bps) |
| `FEE_DENOMINATOR` | `1e6` | Fee denominator |

```solidity
CoreSimulatorLib.setPerpMakerFee(300);  // 0.03%
CoreSimulatorLib.setPerpMakerFee(0);    // Disable perp fees
```

---

### API Reference

#### Block Advancement

| Function | Description |
|----------|-------------|
| `nextBlock()` | Advance one block. Auto-fills executable spot and perp orders. |
| `nextBlock(bool expectRevert)` | Same, but doesn't revert on action failures when `true`. |

#### Queue & Settlement — Spot (Level 2)

| Function | Description |
|----------|-------------|
| `getQueuedActionCount()` | Number of pending actions. |
| `getDeferredOrderCount()` | Number of deferred spot limit orders. |
| `consumeAllAndReturn()` | Drain queue and return all actions. |
| `applyFilledSpotOrder(action, executionPrice)` | Apply FILLED outcome. |
| `applyPartialFilledSpotOrder(action, filledAmount, executionPrice)` | Apply PARTIAL_FILLED outcome. |
| `applyRejectedAction(action, reason)` | Apply REJECTED outcome. |
| `applyErrorAction(action, reason)` | Apply ERROR outcome. |

#### Queue & Settlement — Perps (Level 2)

| Function | Description |
|----------|-------------|
| `getDeferredPerpOrderCount()` | Number of deferred perp limit orders. |
| `applyFilledPerpOrder(action, executionPrice)` | Apply FILLED perp outcome. |
| `applyPartialFilledPerpOrder(action, filledSz, executionPrice)` | Apply PARTIAL_FILLED perp outcome. |
| `applyRejectedPerpAction(action, reason)` | Apply REJECTED perp outcome. |
| `applyErrorPerpAction(action, reason)` | Apply ERROR perp outcome. |
| `applyPerpBridgeActionResult(...)` | Raw passthrough to HyperCore perp bridge. |

#### State Manipulation

| Function | Description |
|----------|-------------|
| `forceAccountActivation(addr)` | Activate a Core account. |
| `forceSpotBalance(addr, token, wei)` | Set spot balance. |
| `forcePerpBalance(addr, perpAsset, margin)` | Set perp margin balance. |
| `forcePerpPositionLeverage(addr, perpAsset, leverage)` | Set perp position leverage. |
| `setSpotPx(spotMarketId, price)` | Set spot market price. |
| `setMarkPx(perpAsset, price)` | Set perp mark price. |
| `setSimulatedL1BlockNumber(l1Block)` | Control L1 block number. |
| `setRevertOnFailure(bool)` | Toggle revert on failure. |
| `setSpotMakerFee(bps)` | Set spot fee rate. |
| `setPerpMakerFee(bps)` | Set perp fee rate. |

---

## Usage Examples

See the [examples](./src/examples/) directory for production library usage.

For testing framework examples:
* [`VHCForkExtensionsTest.t.sol`](./test/unit-tests/vhc/VHCForkExtensionsTest.t.sol) — Level 1 auto-apply (spot)
* [`VHCLevel2Test.t.sol`](./test/unit-tests/vhc/VHCLevel2Test.t.sol) — Level 2 explicit settlement (spot)
* [`VHCFeeSettlementTest.t.sol`](./test/unit-tests/vhc/VHCFeeSettlementTest.t.sol) — Fee settlement and deferred orders
* [`VHCPerpLevel1Test.t.sol`](./test/unit-tests/vhc/VHCPerpLevel1Test.t.sol) — Level 1 auto-apply (perps): open/close/increase positions, PnL, fees, deferred orders
* [`VHCPerpLevel2Test.t.sol`](./test/unit-tests/vhc/VHCPerpLevel2Test.t.sol) — Level 2 explicit settlement (perps): filled, partial, rejected, error outcomes
* [`CoreSimulatorTest.t.sol`](./test/CoreSimulatorTest.t.sol) — General simulation tests

---

## Security Considerations

* `bridgeToEvm()` for non-HYPE tokens requires the contract to hold HYPE on HyperCore for gas; otherwise, the `spotSend` will fail.
* Be aware of potential precision loss in `evmToWei()` when the EVM token decimals exceed Core decimals, due to integer division during downscaling.
* Ensure that contracts are deployed with complete functionality to prevent stuck assets in Core (e.g., implementing `bridgeToCore` but not `bridgeToEvm` can lead to stuck assets on HyperCore).
* Precompiles return data from the start of the block — CoreWriter actions won't be reflected until the next call.

---

## Origin & Credits

This toolkit is a fork and extension of [`hyper-evm-lib`](https://github.com/hyperliquid-dev/hyper-evm-lib) by [Obsidian Audits](https://github.com/ObsidianAudits) ([0xjuaan](https://github.com/0xjuaan), [0xSpearmint](https://github.com/0xspearmint)), with additions by [Endix](https://github.com/endix-foundation-v1):

- **Virtual HyperCore (VHC)** — Three-tier local testing framework for spot and perps
- **Level 3 Bridge** — TypeScript CLOB matching engine for realistic async settlement (spot + perps)
- **Perp Bridge Settlement** — Full perpetual contract simulation with position tracking, PnL, fees, and deferred orders

For support, bug reports, or integration questions, open an [issue](https://github.com/endix-foundation-v1/hyper-evm-toolkit/issues).

Contributions welcome. Help us make building on Hyperliquid as smooth and secure as possible.
