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

contract VHCLevel2Test is BaseSimulatorTest {
    using SafeCast for uint256;

    uint32 internal constant SPOT_INDEX = 1;
    uint64 internal constant BASE_TOKEN = 1;
    uint64 internal constant QUOTE_TOKEN = 0;

    uint64 internal constant PRICE_100 = 100e8;
    uint64 internal constant PRICE_95 = 95e8;
    uint64 internal constant PRICE_110 = 110e8;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();

        _registerSpotMarket();

        CoreSimulatorLib.forceAccountActivation(alice);
        CoreSimulatorLib.forceAccountActivation(bob);

        CoreSimulatorLib.forceSpotBalance(alice, QUOTE_TOKEN, 2_000_000e8);
        CoreSimulatorLib.forceSpotBalance(alice, BASE_TOKEN, 5_000e8);

        CoreSimulatorLib.forceSpotBalance(bob, QUOTE_TOKEN, 2_000_000e8);
        CoreSimulatorLib.forceSpotBalance(bob, BASE_TOKEN, 5_000e8);

        _setSpotPxNormalized(PRICE_100);
        CoreSimulatorLib.setCoreWriterQueueMode();
    }

    function test_level2_explicitFilledSpotBuy() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, true, PRICE_100, uint64(2e8), uint128(1001));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyFilledSpotOrder(action, PRICE_100);

        uint64 quoteAmount = _quoteAmount(uint64(2e8), PRICE_100);
        uint64 feeAmount = _feeAmount(quoteAmount);

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - quoteAmount - feeAmount);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + 2e8);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            1001,
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            action.l1Block,
            uint64(2e8),
            PRICE_100
        );
    }

    function test_level2_explicitFilledSpotSell() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(bob, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(bob, BASE_TOKEN).total;

        _queueSpotOrder(bob, false, PRICE_100, uint64(3e8), uint128(1002));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyFilledSpotOrder(action, PRICE_100);

        uint64 quoteAmount = _quoteAmount(uint64(3e8), PRICE_100);
        uint64 feeAmount = _feeAmount(quoteAmount);

        assertEq(PrecompileLib.spotBalance(bob, BASE_TOKEN).total, baseBefore - 3e8);
        assertEq(PrecompileLib.spotBalance(bob, QUOTE_TOKEN).total, quoteBefore + quoteAmount - feeAmount);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            1002,
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            action.l1Block,
            uint64(3e8),
            PRICE_100
        );
    }

    function test_level2_rejectedOrder() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, true, PRICE_100, uint64(2e8), uint128(1003));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyRejectedAction(action, uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE));

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            1003,
            uint8(HyperCore.BridgeActionStatus.REJECTED),
            uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE),
            action.l1Block,
            0,
            0
        );
    }

    function test_level2_partialFill() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, true, PRICE_100, uint64(5e8), uint128(1004));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyPartialFilledSpotOrder(action, uint64(2e8), PRICE_95);

        uint64 quoteAmount = _quoteAmount(uint64(2e8), PRICE_95);
        uint64 feeAmount = _feeAmount(quoteAmount);

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - quoteAmount - feeAmount);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + 2e8);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            1004,
            uint8(HyperCore.BridgeActionStatus.PARTIAL_FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            action.l1Block,
            uint64(2e8),
            PRICE_95
        );
    }

    function test_level2_errorWithReason() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, false, PRICE_100, uint64(2e8), uint128(1005));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        CoreSimulatorLib.applyErrorAction(action, uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR));

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            1005,
            uint8(HyperCore.BridgeActionStatus.ERROR),
            uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR),
            action.l1Block,
            0,
            0
        );
    }

    function test_level2_canceledOrder() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, false, PRICE_100, uint64(2e8), uint128(1006));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory action = _consumeSingleAction();
        uint128 cloid = _decodeCloid(action.payload);

        CoreSimulatorLib.markBridgeActionProcessed(
            action.actionId,
            uint8(HyperCore.BridgeActionStatus.CANCELED),
            uint8(HyperCore.BridgeReasonCode.ORDER_NOT_FOUND),
            action.l1Block,
            cloid
        );

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore);
        assertTrue(hyperCore.processedActions(action.actionId));

        _assertOutcome(
            1006,
            uint8(HyperCore.BridgeActionStatus.CANCELED),
            uint8(HyperCore.BridgeReasonCode.ORDER_NOT_FOUND),
            action.l1Block,
            0,
            0
        );
    }

    function test_level2_multipleActionsExplicit() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, true, PRICE_100, uint64(2e8), uint128(2001));
        _queueSpotOrder(alice, false, PRICE_100, uint64(1e8), uint128(2002));
        _queueSpotOrder(alice, true, PRICE_100, uint64(3e8), uint128(2003));

        assertEq(CoreSimulatorLib.getQueuedActionCount(), 3);

        CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.consumeAllAndReturn();
        assertEq(actions.length, 3);
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);

        CoreSimulatorLib.applyFilledSpotOrder(actions[0], PRICE_100);
        {
            (uint32 asset, bool isBuy, uint128 cloid) = _decodeSpotActionMeta(actions[1].payload);
            assertEq(asset, uint32(10000 + SPOT_INDEX));

            CoreSimulatorLib.applyBridgeActionResult(
                actions[1].actionId,
                actions[1].sender,
                SPOT_INDEX,
                isBuy,
                BASE_TOKEN,
                QUOTE_TOKEN,
                uint64(1e8),
                PRICE_110,
                cloid,
                uint8(HyperCore.BridgeActionStatus.OPEN),
                uint8(HyperCore.BridgeReasonCode.NONE),
                actions[1].l1Block
            );
        }

        CoreSimulatorLib.markBridgeActionProcessed(
            actions[2].actionId,
            uint8(HyperCore.BridgeActionStatus.UNSUPPORTED),
            uint8(HyperCore.BridgeReasonCode.UNSUPPORTED_KIND),
            actions[2].l1Block,
            _decodeCloid(actions[2].payload)
        );

        uint64 buyQuote = _quoteAmount(uint64(2e8), PRICE_100);
        uint64 buyFee = _feeAmount(buyQuote);
        uint64 sellQuote = _quoteAmount(uint64(1e8), PRICE_110);
        uint64 sellFee = _feeAmount(sellQuote);

        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + 1e8);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - buyQuote - buyFee + sellQuote - sellFee);

        _assertOutcome(
            2001,
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            actions[0].l1Block,
            uint64(2e8),
            PRICE_100
        );
        _assertOutcome(
            2002,
            uint8(HyperCore.BridgeActionStatus.OPEN),
            uint8(HyperCore.BridgeReasonCode.NONE),
            actions[1].l1Block,
            uint64(1e8),
            PRICE_110
        );
        _assertOutcome(
            2003,
            uint8(HyperCore.BridgeActionStatus.UNSUPPORTED),
            uint8(HyperCore.BridgeReasonCode.UNSUPPORTED_KIND),
            actions[2].l1Block,
            0,
            0
        );
    }

    function test_level2_mixedLevel1Level2() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, true, PRICE_100, uint64(2e8), uint128(3001));
        CoreWriterSim.QueuedAction[] memory queuedBeforeLevel1 = CoreSimulatorLib.getQueuedActions(0, 1);
        assertEq(queuedBeforeLevel1.length, 1);

        CoreSimulatorLib.nextBlock();
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);

        uint64 level1Quote = _quoteAmount(uint64(2e8), PRICE_100);
        uint64 level1Fee = _feeAmount(level1Quote);

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - level1Quote - level1Fee);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + 2e8);
        _assertOutcome(
            3001,
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            queuedBeforeLevel1[0].l1Block,
            uint64(2e8),
            PRICE_100
        );

        uint64 quoteAfterLevel1 = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseAfterLevel1 = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _queueSpotOrder(alice, true, PRICE_100, uint64(1e8), uint128(3002));
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction memory level2Action = _consumeSingleAction();
        CoreSimulatorLib.applyRejectedAction(level2Action, uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR));

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteAfterLevel1);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseAfterLevel1);
        _assertOutcome(
            3002,
            uint8(HyperCore.BridgeActionStatus.REJECTED),
            uint8(HyperCore.BridgeReasonCode.ENGINE_ERROR),
            level2Action.l1Block,
            0,
            0
        );
    }

    function _queueSpotOrder(address trader, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid) internal {
        vm.prank(trader);
        CoreWriterLib.placeLimitOrder(
            uint32(10000 + SPOT_INDEX),
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

    function _decodeSpotActionMeta(bytes memory payload)
        internal
        pure
        returns (uint32 asset, bool isBuy, uint128 cloid)
    {
        (asset, isBuy,,,,, cloid) = abi.decode(payload, (uint32, bool, uint64, uint64, bool, uint8, uint128));
    }

    function _decodeCloid(bytes memory payload) internal pure returns (uint128 cloid) {
        (,, cloid) = _decodeSpotActionMeta(payload);
    }

    function _assertOutcome(
        uint128 cloid,
        uint8 status,
        uint8 reason,
        uint64 l1Block,
        uint64 filledAmount,
        uint64 executionPrice
    ) internal view {
        (uint8 storedStatus, uint8 storedReason, uint64 storedL1Block, uint64 storedFilledAmount, uint64 storedExecutionPrice)
        = hyperCore.getOrderOutcome(cloid);

        assertEq(storedStatus, status);
        assertEq(storedReason, reason);
        assertEq(storedL1Block, l1Block);
        assertEq(storedFilledAmount, filledAmount);
        assertEq(storedExecutionPrice, executionPrice);
    }

    function _quoteAmount(uint64 filledAmount, uint64 executionPrice) internal pure returns (uint64) {
        return ((uint256(filledAmount) * uint256(executionPrice)) / 1e8).toUint64();
    }

    function _feeAmount(uint64 quoteAmount) internal view returns (uint64) {
        return ((uint256(quoteAmount) * uint256(hyperCore.spotMakerFee())) / hyperCore.FEE_DENOMINATOR()).toUint64();
    }

    function _setSpotPxNormalized(uint64 normalizedSpotPx) internal {
        uint8 baseSzDecimals = PrecompileLib.tokenInfo(BASE_TOKEN).szDecimals;
        uint64 rawSpotPx = (uint256(normalizedSpotPx) / (10 ** baseSzDecimals)).toUint64();
        CoreSimulatorLib.setSpotPx(SPOT_INDEX, rawSpotPx);
    }

    function _registerSpotMarket() internal {
        uint64[] memory quoteSpots = new uint64[](1);
        quoteSpots[0] = SPOT_INDEX;

        uint64[] memory baseSpots = new uint64[](1);
        baseSpots[0] = SPOT_INDEX;

        hyperCore.registerToken(
            QUOTE_TOKEN,
            PrecompileLib.TokenInfo({
                name: "USDC",
                spots: quoteSpots,
                deployerTradingFeeShare: 0,
                deployer: address(0),
                evmContract: address(0),
                szDecimals: 6,
                weiDecimals: 8,
                evmExtraWeiDecimals: -2
            })
        );

        hyperCore.registerToken(
            BASE_TOKEN,
            PrecompileLib.TokenInfo({
                name: "BASE",
                spots: baseSpots,
                deployerTradingFeeShare: 0,
                deployer: address(0),
                evmContract: address(0),
                szDecimals: 8,
                weiDecimals: 8,
                evmExtraWeiDecimals: 0
            })
        );

        hyperCore.registerSpotMarket(
            SPOT_INDEX, PrecompileLib.SpotInfo({name: "BASE/USDC", tokens: [BASE_TOKEN, QUOTE_TOKEN]})
        );
    }
}
