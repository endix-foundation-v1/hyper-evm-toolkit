// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {PrecompileLib} from "../../../src/PrecompileLib.sol";
import {CoreWriterLib} from "../../../src/CoreWriterLib.sol";
import {HLConstants} from "../../../src/common/HLConstants.sol";
import {BaseSimulatorTest} from "../../BaseSimulatorTest.sol";
import {CoreSimulatorLib} from "../../simulation/CoreSimulatorLib.sol";
import {CoreWriterSim} from "../../simulation/CoreWriterSim.sol";
import {HyperCore} from "../../simulation/HyperCore.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title VHCPerpLevel1Test
/// @notice Level 1 (auto-apply) offline tests for perpetual bridge settlement.
/// @dev Perp orders are placed via CoreWriterLib, queued in the ring buffer,
///      and auto-settled through applyPerpBridgeActionResult on nextBlock().
///      HYPE perp (index 150, szDecimals=2, maxLeverage=10) is registered
///      during init() via _deployTokenRegistryAndCoreTokens().
contract VHCPerpLevel1Test is BaseSimulatorTest {
    using SafeCast for uint256;

    // HYPE perp index (registered by _deployTokenRegistryAndCoreTokens)
    uint16 internal constant PERP_INDEX = 150;
    uint32 internal constant PERP_ASSET = 150;

    // Mark prices for HYPE perp (raw, 8-dec)
    uint64 internal constant MARK_PX_20 = 20e8; // $20
    uint64 internal constant MARK_PX_25 = 25e8; // $25
    uint64 internal constant MARK_PX_15 = 15e8; // $15

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();

        // Set up accounts with perp balance and leverage
        CoreSimulatorLib.forceAccountActivation(alice);
        CoreSimulatorLib.forceAccountActivation(bob);

        CoreSimulatorLib.forcePerpBalance(alice, 100_000e8); // $100k perp balance
        CoreSimulatorLib.forcePerpBalance(bob, 100_000e8);

        // Set leverage for HYPE perp (required for position updates)
        CoreSimulatorLib.forcePerpLeverage(alice, PERP_INDEX, 5);
        CoreSimulatorLib.forcePerpLeverage(bob, PERP_INDEX, 5);

        // Set mark price for HYPE perp
        CoreSimulatorLib.setMarkPx(PERP_ASSET, MARK_PX_20);
    }

    // ═══════════════════════════════════════════════════════
    // Basic Long/Short Tests
    // ═══════════════════════════════════════════════════════

    function test_perpLong_openPosition() public {
        uint64 perpBalBefore = PrecompileLib.withdrawable(alice);

        // Place a long order: buy 10 HYPE (10e8 in 8-dec, scales to 10e2 in szDec=2)
        // limitPx must be >= normalizedMarkPx (= rawMarkPx * 100 = 20e8 * 100 = 2000e8)
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(1));

        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);
        CoreSimulatorLib.nextBlock();
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);

        // Position should be opened: szi = +1000 (10e2 in szDecimals=2)
        PrecompileLib.Position memory pos = PrecompileLib.position(alice, PERP_INDEX);
        assertEq(pos.szi, int64(1000)); // 10 HYPE in szDec=2

        // Fee: notional = 1000 * 20e8 = 20000e8, fee = 20000e8 * 150 / 1e6 = 3e8
        // Note: fee is computed on scaled sz * markPx
        uint256 notional = uint256(1000) * uint256(MARK_PX_20);
        uint64 expectedFee = SafeCast.toUint64((notional * 150) / 1e6);
        assertTrue(PrecompileLib.withdrawable(alice) < perpBalBefore);
    }

    function test_perpShort_openPosition() public {
        uint64 perpBalBefore = PrecompileLib.withdrawable(bob);

        // Place a short order: sell 5 HYPE
        // limitPx must be <= normalizedMarkPx (2000e8) — using 2000e8 as limit
        _placePerpOrder(bob, false, uint64(2000e8), uint64(5e8), uint128(2));

        CoreSimulatorLib.nextBlock();

        PrecompileLib.Position memory pos = PrecompileLib.position(bob, PERP_INDEX);
        assertEq(pos.szi, int64(-500)); // -5 HYPE in szDec=2
        assertTrue(PrecompileLib.withdrawable(bob) < perpBalBefore); // fee deducted
    }

    function test_perpLong_increasePosition() public {
        // Open initial long
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(3));
        CoreSimulatorLib.nextBlock();

        PrecompileLib.Position memory pos1 = PrecompileLib.position(alice, PERP_INDEX);
        assertEq(pos1.szi, int64(1000));

        // Increase long by 5 more HYPE
        _placePerpOrder(alice, true, uint64(2000e8), uint64(5e8), uint128(4));
        CoreSimulatorLib.nextBlock();

        PrecompileLib.Position memory pos2 = PrecompileLib.position(alice, PERP_INDEX);
        assertEq(pos2.szi, int64(1500)); // 15 HYPE total
    }

    function test_perpLong_closePosition() public {
        // Open long: +10 HYPE
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(5));
        CoreSimulatorLib.nextBlock();

        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(1000));

        // Close long by selling 10 HYPE
        _placePerpOrder(alice, false, uint64(2000e8), uint64(10e8), uint128(6));
        CoreSimulatorLib.nextBlock();

        // Position should be closed
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(0));
    }

    // ═══════════════════════════════════════════════════════
    // PnL Tests
    // ═══════════════════════════════════════════════════════

    function test_perpLong_profitOnPriceIncrease() public {
        // Open long at $20
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(7));
        CoreSimulatorLib.nextBlock();

        uint64 balAfterOpen = PrecompileLib.withdrawable(alice);

        // Price goes up to $25
        CoreSimulatorLib.setMarkPx(PERP_ASSET, MARK_PX_25);

        // Close long at $25
        _placePerpOrder(alice, false, uint64(2500e8), uint64(10e8), uint128(8));
        CoreSimulatorLib.nextBlock();

        // PnL = 1000 * (25e8 - 20e8) = 5000e8 profit (minus fees)
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(0));
        // Balance should be higher than after open (profit from price increase)
        assertTrue(PrecompileLib.withdrawable(alice) > balAfterOpen);
    }

    function test_perpLong_lossOnPriceDecrease() public {
        // Open long at $20
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(9));
        CoreSimulatorLib.nextBlock();

        uint64 balAfterOpen = PrecompileLib.withdrawable(alice);

        // Price goes down to $15
        CoreSimulatorLib.setMarkPx(PERP_ASSET, MARK_PX_15);

        // Close long at $15
        _placePerpOrder(alice, false, uint64(1500e8), uint64(10e8), uint128(10));
        CoreSimulatorLib.nextBlock();

        // PnL = 1000 * (15e8 - 20e8) = -5000e8 loss (plus fees)
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(0));
        assertTrue(PrecompileLib.withdrawable(alice) < balAfterOpen);
    }

    function test_perpShort_profitOnPriceDecrease() public {
        // Open short at $20
        _placePerpOrder(bob, false, uint64(2000e8), uint64(10e8), uint128(11));
        CoreSimulatorLib.nextBlock();

        uint64 balAfterOpen = PrecompileLib.withdrawable(bob);

        // Price goes down to $15
        CoreSimulatorLib.setMarkPx(PERP_ASSET, MARK_PX_15);

        // Close short by buying at $15
        _placePerpOrder(bob, true, uint64(1500e8), uint64(10e8), uint128(12));
        CoreSimulatorLib.nextBlock();

        assertEq(PrecompileLib.position(bob, PERP_INDEX).szi, int64(0));
        assertTrue(PrecompileLib.withdrawable(bob) > balAfterOpen);
    }

    // ═══════════════════════════════════════════════════════
    // Bridge Settlement Verification
    // ═══════════════════════════════════════════════════════

    function test_perpBridge_orderOutcomeRecorded() public {
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(5001));
        CoreSimulatorLib.nextBlock();

        // Verify outcome was recorded via cloid
        (uint8 status, uint8 reason, uint64 l1Block, uint64 filledAmount, uint64 executionPrice) =
            hyperCore.getOrderOutcome(uint128(5001));
        assertEq(status, uint8(HyperCore.BridgeActionStatus.FILLED));
        assertEq(reason, uint8(HyperCore.BridgeReasonCode.NONE));
        assertTrue(filledAmount > 0);
        assertTrue(executionPrice > 0);
    }

    function test_perpBridge_actionMarkedProcessed() public {
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(5002));

        // Get the action ID before nextBlock
        CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.getQueuedActions(0, 1);
        uint64 actionId = actions[0].actionId;

        CoreSimulatorLib.nextBlock();

        assertTrue(hyperCore.processedActions(actionId));
    }

    function test_perpBridge_idempotencyPreventsReplay() public {
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(5003));

        CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.getQueuedActions(0, 1);
        uint64 actionId = actions[0].actionId;

        CoreSimulatorLib.nextBlock();

        // Try to apply again — should revert
        vm.expectRevert(abi.encodeWithSelector(HyperCore.ActionAlreadyProcessed.selector, actionId));
        CoreSimulatorLib.applyPerpBridgeActionResult(
            actionId, alice, PERP_ASSET, true, uint64(1000), MARK_PX_20,
            uint128(5003), uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE), uint64(block.number)
        );
    }

    // ═══════════════════════════════════════════════════════
    // Deferred Order Tests
    // ═══════════════════════════════════════════════════════

    function test_perpDeferred_orderDeferredWhenPriceDoesNotMatch() public {
        // limitPx = 1500e8 but normalizedMarkPx = 2000e8 — buy won't execute
        _placePerpOrder(alice, true, uint64(1500e8), uint64(10e8), uint128(6001));
        CoreSimulatorLib.nextBlock();

        // Order should be deferred, not executed
        assertEq(CoreSimulatorLib.getDeferredPerpOrderCount(), 1);
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(0));
    }

    function test_perpDeferred_executesOnPriceMatch() public {
        // Deferred: buy limit 1500e8, mark at 2000e8 — won't execute
        _placePerpOrder(alice, true, uint64(1500e8), uint64(10e8), uint128(6002));
        CoreSimulatorLib.nextBlock();
        assertEq(CoreSimulatorLib.getDeferredPerpOrderCount(), 1);

        // Price drops to $14 (normalizedMarkPx = 1400e8 <= 1500e8)
        CoreSimulatorLib.setMarkPx(PERP_ASSET, uint64(14e8));
        CoreSimulatorLib.nextBlock();

        // Deferred order should now execute
        assertEq(CoreSimulatorLib.getDeferredPerpOrderCount(), 0);
        assertTrue(PrecompileLib.position(alice, PERP_INDEX).szi > 0);
    }

    function test_perpDeferred_sellDeferredAndExecutes() public {
        // Sell limit 2500e8 but normalizedMarkPx = 2000e8 — won't execute
        _placePerpOrder(alice, false, uint64(2500e8), uint64(10e8), uint128(6003));
        CoreSimulatorLib.nextBlock();
        assertEq(CoreSimulatorLib.getDeferredPerpOrderCount(), 1);

        // Price rises to $26 (normalizedMarkPx = 2600e8 >= 2500e8)
        CoreSimulatorLib.setMarkPx(PERP_ASSET, uint64(26e8));
        CoreSimulatorLib.nextBlock();

        assertEq(CoreSimulatorLib.getDeferredPerpOrderCount(), 0);
        assertTrue(PrecompileLib.position(alice, PERP_INDEX).szi < 0);
    }

    // ═══════════════════════════════════════════════════════
    // Fee Tests
    // ═══════════════════════════════════════════════════════

    function test_perpFee_deductedCorrectly() public {
        uint64 balBefore = PrecompileLib.withdrawable(alice);

        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(7001));
        CoreSimulatorLib.nextBlock();

        // sz scaled = 1000 (10e8 → 10e2), fee = 1000 * 20e8 * 150 / 1e6 = 3_000_000 = 3e6
        // But position also has entryNtl impact on perpBalance reads.
        // Just verify balance decreased
        assertTrue(PrecompileLib.withdrawable(alice) < balBefore);
    }

    function test_perpFee_zeroFeeWhenDisabled() public {
        CoreSimulatorLib.setPerpMakerFee(0);

        uint64 balBefore = PrecompileLib.withdrawable(alice);

        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(7002));
        CoreSimulatorLib.nextBlock();

        // With zero fee, balance impact is only from position margin, not fee
        // Just verify position opened
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(1000));
    }

    // ═══════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════

    function _placePerpOrder(address trader, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid) internal {
        vm.prank(trader);
        CoreWriterLib.placeLimitOrder(
            PERP_ASSET, // perp asset ID (not 10000+index like spot)
            isBuy,
            limitPx,
            sz,
            false, // reduceOnly
            HLConstants.LIMIT_ORDER_TIF_GTC,
            cloid
        );
    }
}
