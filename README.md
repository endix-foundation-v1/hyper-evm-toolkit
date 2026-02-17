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

All spot order settlement flows through a single path: **`applyBridgeActionResult()`**. This function updates core spot balances, deducts fees, records the order outcome, and emits a `BridgeActionApplied` event — mirroring how the real Hyperliquid bridge settles spot orders from EVM.

```
Your Contract
    │
    ├─ CoreWriterLib.placeLimitOrder()   ──►  CoreWriterSim (ring buffer queue)
    ├─ PrecompileLib.spotBalance()       ──►  PrecompileSim (reads from HyperCore state)
    │
    └─ nextBlock()                       ──►  CoreSimulatorLib
                                                ├─ Advance block number + timestamp
                                                ├─ Check deferred limit orders
                                                └─ Auto-apply queued spot orders via applyBridgeActionResult()
```

### Two Runtime Modes

| Mode | Activation | Behavior |
|------|-----------|----------|
| **Offline** (default) | `forge test` | Pure local simulation. Zero RPC calls. All state is mocked. Fast. |
| **Fork** | `FORK_MODE=true forge test` | Forks real Hyperliquid chain state. Falls back to real chain data for unmocked state. |

### Three Testing Tiers

| Tier | Settlement Method | Learning Curve | Best For |
|------|-------------------|----------------|----------|
| **Level 1 — Auto-Apply** | `nextBlock()` auto-fills all queued spot orders at the limit price | Zero | Most protocol tests |
| **Level 2 — Explicit Settlement** | `consumeAllAndReturn()` + manual `applyFilledSpotOrder()`, `applyRejectedAction()`, etc. | Moderate | Testing rejection, partial fill, error handling |
| **Level 3 — Realistic Bridge** | TypeScript bridge with real CLOB matching engine ([`bridge/`](./bridge/)) | Advanced | Production-grade simulation with realistic async settlement |

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

**Available Level 2 helpers:**

| Function | Outcome | Balance Effect |
|----------|---------|----------------|
| `applyFilledSpotOrder(action, executionPrice)` | FILLED | Full balance update with fees |
| `applyPartialFilledSpotOrder(action, filledAmount, executionPrice)` | PARTIAL_FILLED | Partial balance update |
| `applyRejectedAction(action, reason)` | REJECTED | No balance change |
| `applyErrorAction(action, reason)` | ERROR | No balance change |

Level 1 and Level 2 can be mixed freely in the same test.

---

### Level 3: Realistic Bridge

The [`bridge/`](./bridge/) directory contains a full TypeScript CLOB matching engine that provides realistic async settlement. It runs as a sidecar process alongside Anvil, polling the CoreWriterSim's ring buffer for queued actions, running them through a real order book, and calling `applyBridgeActionResult()` with the matching result.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your Contract   │────►│  CoreWriterSim   │────►│  TS Bridge      │
│  (Foundry test)  │     │  (ring buffer)   │     │  (CLOB engine)  │
│                  │◄────│                  │◄────│                 │
│  balances update │     │  applyBridge...  │     │  match result   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

Features:
- Price-time priority CLOB matching engine
- Limit, market, IOC, FOK, GTC order support
- Iceberg orders with reserve quantities
- Self-trade prevention
- Deterministic replay via command log
- WebSocket real-time order book / trade streams

See [`bridge/README.md`](./bridge/README.md) for full documentation.

```bash
cd bridge && npm install && npm run dev
```

---

### Fee Settlement

Fees are computed inside `applyBridgeActionResult()`:

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

---

### API Reference

#### Block Advancement

| Function | Description |
|----------|-------------|
| `nextBlock()` | Advance one block. Auto-fills executable spot orders. |
| `nextBlock(bool expectRevert)` | Same, but doesn't revert on action failures when `true`. |

#### Queue & Settlement (Level 2)

| Function | Description |
|----------|-------------|
| `getQueuedActionCount()` | Number of pending actions. |
| `getDeferredOrderCount()` | Number of deferred limit orders. |
| `consumeAllAndReturn()` | Drain queue and return all actions. |
| `applyFilledSpotOrder(action, executionPrice)` | Apply FILLED outcome. |
| `applyPartialFilledSpotOrder(action, filledAmount, executionPrice)` | Apply PARTIAL_FILLED outcome. |
| `applyRejectedAction(action, reason)` | Apply REJECTED outcome. |
| `applyErrorAction(action, reason)` | Apply ERROR outcome. |

#### State Manipulation

| Function | Description |
|----------|-------------|
| `forceAccountActivation(addr)` | Activate a Core account. |
| `forceSpotBalance(addr, token, wei)` | Set spot balance. |
| `setSpotPx(spotMarketId, price)` | Set spot market price. |
| `setSimulatedL1BlockNumber(l1Block)` | Control L1 block number. |
| `setRevertOnFailure(bool)` | Toggle revert on failure. |
| `setSpotMakerFee(bps)` | Set spot fee rate. |

---

## Usage Examples

See the [examples](./src/examples/) directory for production library usage.

For testing framework examples:
* [`VHCForkExtensionsTest.t.sol`](./test/unit-tests/vhc/VHCForkExtensionsTest.t.sol) — Level 1 auto-apply
* [`VHCLevel2Test.t.sol`](./test/unit-tests/vhc/VHCLevel2Test.t.sol) — Level 2 explicit settlement
* [`VHCFeeSettlementTest.t.sol`](./test/unit-tests/vhc/VHCFeeSettlementTest.t.sol) — Fee settlement and deferred orders
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

- **Virtual HyperCore (VHC)** — Three-tier local testing framework
- **Level 3 Bridge** — TypeScript CLOB matching engine for realistic async settlement
- **Perps extension points** — Scaffolding for perpetual contract simulation

For support, bug reports, or integration questions, open an [issue](https://github.com/endix-foundation-v1/hyper-evm-toolkit/issues).

Contributions welcome. Help us make building on Hyperliquid as smooth and secure as possible.
