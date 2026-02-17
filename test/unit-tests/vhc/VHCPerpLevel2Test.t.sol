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

/// @title VHCPerpLevel2Test
/// @notice Level 2 (explicit settlement) offline tests for perpetual bridge settlement.
/// @dev Perp orders are consumed from the queue and manually settled using
///      applyFilledPerpOrder, applyRejectedPerpAction, applyPartialFilledPerpOrder,
///      applyErrorPerpAction, and the raw applyPerpBridgeActionResult passthrough.
contract VHCPerpLevel2Test is BaseSimulatorTest {
    using SafeCast for uint256;

    uint16 internal constant PERP_INDEX = 150;
    uint32 internal constant PERP_ASSET = 150;

    uint64 internal constant MARK_PX_20 = 20e8;
    uint64 internal constant MARK_PX_25 = 25e8;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();

        CoreSimulatorLib.forceAccountActivation(alice);
        CoreSimulatorLib.forceAccountActivation(bob);

        CoreSimulatorLib.forcePerpBalance(alice, 100_000e8);
        CoreSimulatorLib.forcePerpBalance(bob, 100_000e8);

        CoreSimulatorLib.forcePerpLeverage(alice, PERP_INDEX, 5);
        CoreSimulatorLib.forcePerpLeverage(bob, PERP_INDEX, 5);

        CoreSimulatorLib.setMarkPx(PERP_ASSET, MARK_PX_20);
    }

    // ═══════════════════════════════════════════════════════
    // Explicit Filled
    // ═══════════════════════════════════════════════════════

    function test_level2_explicitFilledPerpLong() public {
        uint64 perpBalBefore = PrecompileLib.withdrawable(alice);

        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(2001));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();

        // Apply filled at mark price
        CoreSimulatorLib.applyFilledPerpOrder(action, MARK_PX_20);

        // Position opened
        PrecompileLib.Position memory pos = PrecompileLib.position(alice, PERP_INDEX);
        assertEq(pos.szi, int64(1000)); // 10 HYPE in szDec=2

        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            2001,
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE)
        );
    }

    function test_level2_explicitFilledPerpShort() public {
        _placePerpOrder(bob, false, uint64(2000e8), uint64(5e8), uint128(2002));

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyFilledPerpOrder(action, MARK_PX_20);

        PrecompileLib.Position memory pos = PrecompileLib.position(bob, PERP_INDEX);
        assertEq(pos.szi, int64(-500)); // -5 HYPE in szDec=2

        assertTrue(hyperCore.processedActions(action.actionId));
        _assertOutcome(2002, uint8(HyperCore.BridgeActionStatus.FILLED), uint8(HyperCore.BridgeReasonCode.NONE));
    }

    // ═══════════════════════════════════════════════════════
    // Rejected / Error / Canceled
    // ═══════════════════════════════════════════════════════

    function test_level2_rejectedPerpOrder() public {
        uint64 perpBalBefore = PrecompileLib.withdrawable(alice);

        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(2003));

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyRejectedPerpAction(action, uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE));

        // No position opened, no balance change
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(0));
        assertEq(PrecompileLib.withdrawable(alice), perpBalBefore);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            2003,
            uint8(HyperCore.BridgeActionStatus.REJECTED),
            uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE)
        );
    }

    function test_level2_errorPerpOrder() public {
        uint64 perpBalBefore = PrecompileLib.withdrawable(alice);

        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(2004));

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyErrorPerpAction(action, uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR));

        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(0));
        assertEq(PrecompileLib.withdrawable(alice), perpBalBefore);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            2004,
            uint8(HyperCore.BridgeActionStatus.ERROR),
            uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR)
        );
    }

    // ═══════════════════════════════════════════════════════
    // Partial Fill
    // ═══════════════════════════════════════════════════════

    function test_level2_partialFilledPerpOrder() public {
        // Order for 10 HYPE (10e8 in 8-dec), partial fill of 5 HYPE
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(2005));

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();

        // Partial fill: 5e8 in 8-dec → scaled to 500 in szDec=2
        CoreSimulatorLib.applyPartialFilledPerpOrder(action, uint64(5e8), MARK_PX_20);

        PrecompileLib.Position memory pos = PrecompileLib.position(alice, PERP_INDEX);
        assertEq(pos.szi, int64(500)); // 5 HYPE, not 10

        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            2005,
            uint8(HyperCore.BridgeActionStatus.PARTIAL_FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE)
        );
    }

    // ═══════════════════════════════════════════════════════
    // Mixed Level 1 + Level 2
    // ═══════════════════════════════════════════════════════

    function test_level2_mixedLevel1AndLevel2Perp() public {
        // Level 1: auto-apply via nextBlock
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(3001));
        CoreSimulatorLib.nextBlock();

        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(1000));

        // Level 2: explicit settlement
        _placePerpOrder(alice, true, uint64(2000e8), uint64(5e8), uint128(3002));
        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyFilledPerpOrder(action, MARK_PX_20);

        // Combined: 1000 + 500 = 1500
        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(1500));
    }

    // ═══════════════════════════════════════════════════════
    // Multiple Actions
    // ═══════════════════════════════════════════════════════

    function test_level2_multipleActionsExplicit() public {
        _placePerpOrder(alice, true, uint64(2000e8), uint64(10e8), uint128(4001));
        _placePerpOrder(bob, false, uint64(2000e8), uint64(5e8), uint128(4002));
        _placePerpOrder(alice, true, uint64(2000e8), uint64(3e8), uint128(4003));

        assertEq(CoreSimulatorLib.getQueuedActionCount(), 3);

        CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.consumeAllAndReturn();
        assertEq(actions.length, 3);
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);

        // Fill alice's first long
        CoreSimulatorLib.applyFilledPerpOrder(actions[0], MARK_PX_20);
        // Reject bob's short
        CoreSimulatorLib.applyRejectedPerpAction(actions[1], uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR));
        // Fill alice's second long
        CoreSimulatorLib.applyFilledPerpOrder(actions[2], MARK_PX_20);

        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(1300)); // 10+3 HYPE = 1300 in szDec=2
        assertEq(PrecompileLib.position(bob, PERP_INDEX).szi, int64(0)); // Rejected, no position

        _assertOutcome(4001, uint8(HyperCore.BridgeActionStatus.FILLED), uint8(HyperCore.BridgeReasonCode.NONE));
        _assertOutcome(4002, uint8(HyperCore.BridgeActionStatus.REJECTED), uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR));
        _assertOutcome(4003, uint8(HyperCore.BridgeActionStatus.FILLED), uint8(HyperCore.BridgeReasonCode.NONE));
    }

    // ═══════════════════════════════════════════════════════
    // Raw Passthrough
    // ═══════════════════════════════════════════════════════

    function test_level2_rawPassthroughPerpBridgeResult() public {
        // Use the raw passthrough to call applyPerpBridgeActionResult directly
        uint64 actionId = 9001;
        uint64 l1Block = 500;

        CoreSimulatorLib.applyPerpBridgeActionResult(
            actionId,
            alice,
            PERP_ASSET,
            true,
            uint64(1000), // Already in szDecimals (10 HYPE in szDec=2)
            MARK_PX_20,
            uint128(9001),
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            l1Block
        );

        assertEq(PrecompileLib.position(alice, PERP_INDEX).szi, int64(1000));
        assertTrue(hyperCore.processedActions(actionId));
        _assertOutcome(9001, uint8(HyperCore.BridgeActionStatus.FILLED), uint8(HyperCore.BridgeReasonCode.NONE));
    }

    // ═══════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════

    function _placePerpOrder(address trader, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid) internal {
        vm.prank(trader);
        CoreWriterLib.placeLimitOrder(
            PERP_ASSET,
            isBuy,
            limitPx,
            sz,
            false,
            HLConstants.LIMIT_ORDER_TIF_GTC,
            cloid
        );
    }

    function _consumeSingleAction() internal returns (CoreWriterSim.QueuedAction memory) {
        CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.consumeAllAndReturn();
        assertEq(actions.length, 1);
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);
        return actions[0];
    }

    function _assertOutcome(uint128 cloid, uint8 expectedStatus, uint8 expectedReason) internal view {
        (uint8 status, uint8 reason,,,) = hyperCore.getOrderOutcome(cloid);
        assertEq(status, expectedStatus);
        assertEq(reason, expectedReason);
    }
}
