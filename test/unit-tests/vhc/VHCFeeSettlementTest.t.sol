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

contract VHCFeeSettlementTest is BaseSimulatorTest {
    using SafeCast for uint256;

    uint32 internal constant SPOT_INDEX = 1;
    uint64 internal constant BASE_TOKEN = 1;
    uint64 internal constant QUOTE_TOKEN = 0;

    uint64 internal constant ORDER_SIZE = 100e8;
    uint64 internal constant PRICE_SCALE = 1e8;
    uint64 internal constant PRICE_100 = 100e8;
    uint64 internal constant PRICE_80 = 80e8;
    uint64 internal constant PRICE_75 = 75e8;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();

        _registerSpotMarket();

        CoreSimulatorLib.forceAccountActivation(alice);
        CoreSimulatorLib.forceAccountActivation(bob);

        CoreSimulatorLib.forceSpotBalance(alice, QUOTE_TOKEN, 100_000_000e8);
        CoreSimulatorLib.forceSpotBalance(alice, BASE_TOKEN, 100_000e8);
        CoreSimulatorLib.forceSpotBalance(bob, QUOTE_TOKEN, 100_000_000e8);
        CoreSimulatorLib.forceSpotBalance(bob, BASE_TOKEN, 100_000e8);

        _setSpotPxNormalized(PRICE_100);
        CoreSimulatorLib.setCoreWriterQueueMode();
    }

    function test_buyWithFee_deductsQuoteCorrectly() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _placeSpotOrder(alice, true, PRICE_100, ORDER_SIZE, 11);
        CoreSimulatorLib.nextBlock();

        uint64 quoteAmount = _quoteAmount(ORDER_SIZE, PRICE_100);
        uint64 feeAmount = _feeAmount(quoteAmount);

        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - quoteAmount - feeAmount);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + ORDER_SIZE);
    }

    function test_sellWithFee_creditsQuoteCorrectly() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(bob, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(bob, BASE_TOKEN).total;

        _placeSpotOrder(bob, false, PRICE_100, ORDER_SIZE, 12);
        CoreSimulatorLib.nextBlock();

        uint64 quoteAmount = _quoteAmount(ORDER_SIZE, PRICE_100);
        uint64 feeAmount = _feeAmount(quoteAmount);

        assertEq(PrecompileLib.spotBalance(bob, QUOTE_TOKEN).total, quoteBefore + quoteAmount - feeAmount);
        assertEq(PrecompileLib.spotBalance(bob, BASE_TOKEN).total, baseBefore - ORDER_SIZE);
    }

    function test_zeroFee_backwardCompatible() public {
        CoreSimulatorLib.setSpotMakerFee(0);

        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _placeSpotOrder(alice, true, PRICE_100, ORDER_SIZE, 13);
        CoreSimulatorLib.nextBlock();

        uint64 quoteAmount = _quoteAmount(ORDER_SIZE, PRICE_100);

        assertEq(_feeAmount(quoteAmount), 0);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - quoteAmount);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + ORDER_SIZE);
    }

    function test_deferredOrder_executesOnPriceMatch() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _placeSpotOrder(alice, true, PRICE_80, ORDER_SIZE, 14);
        CoreSimulatorLib.nextBlock();

        assertEq(CoreSimulatorLib.getDeferredOrderCount(), 1);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore);

        _setSpotPxNormalized(PRICE_75);
        CoreSimulatorLib.nextBlock();

        uint64 quoteAmount = _quoteAmount(ORDER_SIZE, PRICE_75);
        uint64 feeAmount = _feeAmount(quoteAmount);

        assertEq(CoreSimulatorLib.getDeferredOrderCount(), 0);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - quoteAmount - feeAmount);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + ORDER_SIZE);

        (,,,, uint64 executionPrice) = hyperCore.getOrderOutcome(14);
        assertEq(executionPrice, PRICE_75);
    }

    function test_deferredOrder_withFeeOnExecution() public {
        CoreSimulatorLib.setSpotMakerFee(400);

        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;

        _placeSpotOrder(alice, true, PRICE_80, ORDER_SIZE, 15);
        CoreSimulatorLib.nextBlock();

        assertEq(CoreSimulatorLib.getDeferredOrderCount(), 1);

        _setSpotPxNormalized(PRICE_75);
        CoreSimulatorLib.nextBlock();

        uint64 quoteAfter = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 actualDebit = quoteBefore - quoteAfter;

        uint64 executionQuote = _quoteAmount(ORDER_SIZE, PRICE_75);
        uint64 executionFee = _feeAmount(executionQuote);

        uint64 deferredQuote = _quoteAmount(ORDER_SIZE, PRICE_100);
        uint64 deferredFee = _feeAmount(deferredQuote);

        assertEq(actualDebit, executionQuote + executionFee);
        assertTrue(actualDebit != deferredQuote + deferredFee);
    }

    function test_spotOrders_neverReachExecuteRawAction() public {
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;
        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;

        _placeSpotOrder(alice, true, uint64(1e8), ORDER_SIZE, 16);
        CoreSimulatorLib.nextBlock();

        assertEq(CoreSimulatorLib.getDeferredOrderCount(), 1);
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore);
        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore);
    }

    function _placeSpotOrder(address trader, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid) internal {
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

    function _quoteAmount(uint64 filledAmount, uint64 executionPrice) internal pure returns (uint64) {
        return ((uint256(filledAmount) * uint256(executionPrice)) / PRICE_SCALE).toUint64();
    }

    function _feeAmount(uint64 quoteAmount) internal view returns (uint64) {
        if (hyperCore.spotMakerFee() == 0) {
            return 0;
        }

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
