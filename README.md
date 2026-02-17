# hyper-evm-lib
![License](https://img.shields.io/github/license/hyperliquid-dev/hyper-evm-lib)
![Solidity](https://img.shields.io/badge/solidity-%3E%3D0.8.0-blue)

<img width="900" height="450" alt="Untitled design (2)" src="https://github.com/user-attachments/assets/6c74dc59-baff-4f6a-9dab-3b92d0cfa133" />

## The all-in-one toolkit to seamlessly build smart contracts on HyperEVM

This library makes it easy to build on HyperEVM. It provides a unified interface for:

* Bridging assets between HyperEVM and Core, abstracting away the complexity of decimal conversions
* Performing all `CoreWriter` actions
* Accessing data from native precompiles without needing a token index
* Retrieving token indexes, and spot market indexes based on their linked evm contract address

The library securely abstracts away the low-level mechanics of Hyperliquid's EVM ↔ Core interactions so you can focus on building your protocol's core business logic.

The testing framework provides a robust simulation engine for HyperCore interactions, enabling local foundry testing of precompile calls, CoreWriter actions, and EVM⇄Core token bridging. This allows developers to test their contracts in a local environment, within seconds, without needing to spend hours deploying and testing on testnet.

---

## Key Components

### CoreWriterLib

Includes functions to call `CoreWriter` actions, and also has helpers to:

* Bridge tokens to/from Core
* Convert spot token amount representation between EVM and Core (wei) decimals

### PrecompileLib

Includes functionality to query the native read precompiles. 

PrecompileLib includes additional functions to query data using EVM token addresses, removing the need to store or pass in the token/spot index. 

### TokenRegistry

Precompiles like `spotBalance`, `spotPx` and more, all require either a token index (for `spotBalance`) or a spot market index (for `spotPx`) as an input parameter.

Natively, there is no way to derive the token index given a token's contract address, requiring projects to store it manually, or pass it in as a parameter whenever needed.

[TokenRegistry](https://github.com/hyperliquid-dev/hyper-evm-lib/blob/main/src/registry/TokenRegistry.sol) solves this by providing a deployed-onchain mapping from EVM contract addresses to their HyperCore token indices, populated trustlessly using precompile lookups for each index.

### Testing Framework

A robust and flexible test engine for HyperCore interactions, enabling local Foundry testing of precompile calls, CoreWriter actions, and EVM⇄Core token bridging. Tests run in seconds locally — no testnet deployments needed.

For general usage and how it works, see the [docs](https://hyperlib.dev/testing/overview).

---

## Virtual HyperCore (VHC) Testing Guide

### Overview

Virtual HyperCore (VHC) is a local simulation of HyperCore that runs entirely inside Foundry. It replaces the real HyperCore precompiles, `CoreWriter`, and `CoreDepositWallet` with simulated contracts, enabling you to write fast, deterministic tests for any protocol that interacts with Hyperliquid's L1.

**How it works:** `CoreSimulatorLib.init()` etches simulated bytecode at the canonical system addresses (`0x3333...` for CoreWriter, `0x9999...` for HyperCore, `0x0800`–`0x0810` for precompiles). Your contracts call `CoreWriterLib` and `PrecompileLib` as normal — they hit the simulated contracts instead of real precompiles, and everything runs locally.

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
| **Level 3 — Realistic Bridge** | TypeScript bridge with real CLOB matching engine | Advanced | Production-grade simulation (separate [`virtual-hypercore`](https://github.com/endix-foundation-v1/virtual-hypercore) package) |

---

### Getting Started

All VHC tests inherit from `BaseSimulatorTest`:

```solidity
import {BaseSimulatorTest} from "@hyper-evm-lib/test/BaseSimulatorTest.sol";
import {CoreSimulatorLib} from "@hyper-evm-lib/test/simulation/CoreSimulatorLib.sol";

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
import {CoreWriterSim} from "@hyper-evm-lib/test/simulation/CoreWriterSim.sol";

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

## Installation

Install with **Foundry**:

```sh
forge install hyperliquid-dev/hyper-evm-lib
echo "@hyper-evm-lib=lib/hyper-evm-lib" >> remappings.txt
```
---

## Usage Examples

See the [examples](./src/examples/) directory for examples of how the libraries can be used in practice.

To see how the testing framework can be used, refer to [`CoreSimulatorTest.t.sol`](./test/CoreSimulatorTest.t.sol) and the testing framework docs at [https://hyperlib.dev](https://hyperlib.dev/).

For VHC-specific examples:
* [`VHCForkExtensionsTest.t.sol`](./test/unit-tests/vhc/VHCForkExtensionsTest.t.sol) — Level 1 and bridge-apply examples
* [`VHCLevel2Test.t.sol`](./test/unit-tests/vhc/VHCLevel2Test.t.sol) — Level 2 explicit settlement
* [`VHCFeeSettlementTest.t.sol`](./test/unit-tests/vhc/VHCFeeSettlementTest.t.sol) — Fee settlement and deferred orders

---

## Security Considerations

* `bridgeToEvm()` for non-HYPE tokens requires the contract to hold HYPE on HyperCore for gas; otherwise, the `spotSend` will fail.
* Be aware of potential precision loss in `evmToWei()` when the EVM token decimals exceed Core decimals, due to integer division during downscaling.
* Ensure that contracts are deployed with complete functionality to prevent stuck assets in Core
  * For example, implementing `bridgeToCore` but not `bridgeToEvm` can lead to stuck, unretrievable assets on HyperCore
* Note that precompiles return data from the start of the block, so CoreWriter actions will not be reflected in precompile data until next call.

---

## Contributing
This toolkit is developed and maintained by the team at [Obsidian Audits](https://github.com/ObsidianAudits):

- [0xjuaan](https://github.com/0xjuaan)
- [0xSpearmint](https://github.com/0xspearmint)

For support, bug reports, or integration questions, open an [issue](https://github.com/hyperliquid-dev/hyper-evm-lib/issues) or reach out on [TG](https://t.me/juan_sec)

The library and testing framework are under active development, and contributions are welcome.

Want to improve or extend functionality? Feel free to create a PR.

Help us make building on Hyperliquid as smooth and secure as possible.
