// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {PrecompileLib} from "../../../src/PrecompileLib.sol";
import {CoreWriterLib} from "../../../src/CoreWriterLib.sol";
import {HLConstants} from "../../../src/common/HLConstants.sol";
import {BaseSimulatorTest} from "../../BaseSimulatorTest.sol";
import {CoreSimulatorLib} from "../../simulation/CoreSimulatorLib.sol";
import {CoreWriterSim} from "../../simulation/CoreWriterSim.sol";
import {HyperCore} from "../../simulation/HyperCore.sol";

interface ICoreDepositWalletSim {
    error InsufficientAmountForActivation();

    function depositFor(address recipient, uint256 amount, uint32 destinationDex) external;
}

contract VHCForkExtensionsTest is BaseSimulatorTest {
    uint32 internal constant SPOT_INDEX = 1;
    uint64 internal constant BASE_TOKEN = 1;
    uint64 internal constant QUOTE_TOKEN = 0;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();

        _registerSpotMarket();

        CoreSimulatorLib.forceAccountActivation(alice);
        CoreSimulatorLib.forceAccountActivation(bob);

        CoreSimulatorLib.forceSpotBalance(alice, QUOTE_TOKEN, 1_000_000e8);
        CoreSimulatorLib.forceSpotBalance(alice, BASE_TOKEN, 1_000e8);

        CoreSimulatorLib.forceSpotBalance(bob, QUOTE_TOKEN, 0);
        CoreSimulatorLib.forceSpotBalance(bob, BASE_TOKEN, 0);

        CoreSimulatorLib.setSpotPx(SPOT_INDEX, 100e8);
    }

    function test_queueMode_enqueuesAndConsumesActions() public {
        CoreSimulatorLib.setCoreWriterQueueMode();

        vm.prank(alice);
        CoreWriterLib.placeLimitOrder(
            uint32(10000 + SPOT_INDEX),
            true,
            uint64(100e8),
            uint64(2e8),
            false,
            HLConstants.LIMIT_ORDER_TIF_GTC,
            uint128(77)
        );

        assertEq(CoreSimulatorLib.getQueuedActionCount(), 1);

        CoreWriterSim.QueuedAction[] memory actions = CoreSimulatorLib.getQueuedActions(0, 10);
        assertEq(actions.length, 1);
        assertEq(actions[0].actionId, 1);
        assertEq(actions[0].sender, alice);
        assertEq(actions[0].kind, HLConstants.LIMIT_ORDER_ACTION);
        assertEq(actions[0].l1Block, uint64(block.number));

        (uint32 asset, bool isBuy, uint64 limitPx, uint64 size,, uint8 tif, uint128 cloid) =
            abi.decode(actions[0].payload, (uint32, bool, uint64, uint64, bool, uint8, uint128));
        assertEq(asset, uint32(10000 + SPOT_INDEX));
        assertTrue(isBuy);
        assertEq(limitPx, uint64(100e8));
        assertEq(size, uint64(2e8));
        assertEq(tif, HLConstants.LIMIT_ORDER_TIF_GTC);
        assertEq(cloid, uint128(77));

        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, 1_000e8);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, 1_000_000e8);

        CoreSimulatorLib.consumeQueuedActions(1);
        assertEq(CoreSimulatorLib.getQueuedActionCount(), 0);
    }

    function test_applyBridgeActionResult_updatesBalancesOutcomeAndIdempotency() public {
        uint64 actionId = 41;
        uint64 l1Block = 701;
        uint128 cloid = 9001;

        uint64 baseBefore = PrecompileLib.spotBalance(alice, BASE_TOKEN).total;
        uint64 quoteBefore = PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total;

        _applyFilledResult(actionId, cloid, l1Block);

        assertTrue(hyperCore.processedActions(actionId));
        assertEq(hyperCore.simulatedL1BlockNumber(), l1Block);

        assertEq(PrecompileLib.spotBalance(alice, BASE_TOKEN).total, baseBefore + 2e8);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, quoteBefore - 200e8);

        (uint8 status, uint8 reason, uint64 storedL1Block, uint64 filledAmount, uint64 executionPrice) =
            hyperCore.getOrderOutcome(cloid);
        assertEq(status, uint8(HyperCore.BridgeActionStatus.FILLED));
        assertEq(reason, uint8(HyperCore.BridgeReasonCode.NONE));
        assertEq(storedL1Block, l1Block);
        assertEq(filledAmount, uint64(2e8));
        assertEq(executionPrice, uint64(100e8));

        vm.expectRevert(abi.encodeWithSelector(HyperCore.ActionAlreadyProcessed.selector, actionId));
        _applyFilledResult(actionId, cloid, l1Block);
    }

    function test_markBridgeActionProcessed_storesRejectedOutcome() public {
        uint64 actionId = 52;
        uint64 l1Block = 811;
        uint128 cloid = 777;

        CoreSimulatorLib.markBridgeActionProcessed(
            actionId,
            uint8(HyperCore.BridgeActionStatus.REJECTED),
            uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE),
            l1Block,
            cloid
        );

        assertTrue(hyperCore.processedActions(actionId));

        (uint8 status, uint8 reason, uint64 storedL1Block, uint64 filledAmount, uint64 executionPrice) =
            hyperCore.getOrderOutcome(cloid);
        assertEq(status, uint8(HyperCore.BridgeActionStatus.REJECTED));
        assertEq(reason, uint8(HyperCore.BridgeReasonCode.INSUFFICIENT_BALANCE));
        assertEq(storedL1Block, l1Block);
        assertEq(filledAmount, 0);
        assertEq(executionPrice, 0);
    }

    function test_applySpotSendAction_transfersAndPreventsReplay() public {
        uint64 actionId = 63;
        uint64 l1Block = 901;

        CoreSimulatorLib.applySpotSendAction(actionId, alice, bob, QUOTE_TOKEN, uint64(500e8), l1Block);

        assertTrue(hyperCore.processedActions(actionId));
        assertEq(hyperCore.simulatedL1BlockNumber(), l1Block);
        assertEq(PrecompileLib.spotBalance(alice, QUOTE_TOKEN).total, 999_500e8);
        assertEq(PrecompileLib.spotBalance(bob, QUOTE_TOKEN).total, 500e8);

        vm.expectRevert(abi.encodeWithSelector(HyperCore.ActionAlreadyProcessed.selector, actionId));
        CoreSimulatorLib.applySpotSendAction(actionId, alice, bob, QUOTE_TOKEN, uint64(1e8), l1Block);
    }

    function test_setSimulatedL1BlockNumber_controlsL1Precompile() public {
        assertEq(PrecompileLib.l1BlockNumber(), uint64(block.number));

        CoreSimulatorLib.setSimulatedL1BlockNumber(1337);
        assertEq(PrecompileLib.l1BlockNumber(), 1337);

        CoreSimulatorLib.setSimulatedL1BlockNumber(1200);
        assertEq(PrecompileLib.l1BlockNumber(), 1337);
    }

    function test_coreDepositWallet_depositForCreditsAndActivatesRecipient() public {
        address recipient = makeAddr("recipient");
        assertFalse(PrecompileLib.coreUserExists(recipient));

        vm.prank(alice);
        _coreDepositWallet().depositFor(recipient, 10e6, type(uint32).max);
        assertEq(PrecompileLib.spotBalance(recipient, QUOTE_TOKEN).total, 9e8);
        assertTrue(PrecompileLib.coreUserExists(recipient));

        vm.prank(alice);
        _coreDepositWallet().depositFor(recipient, 10e6, type(uint32).max);
        assertEq(PrecompileLib.spotBalance(recipient, QUOTE_TOKEN).total, 19e8);
    }

    function test_coreDepositWallet_revertsWhenFirstDepositBelowActivationFee() public {
        address recipient = makeAddr("small-first-deposit");

        vm.prank(alice);
        vm.expectRevert(ICoreDepositWalletSim.InsufficientAmountForActivation.selector);
        _coreDepositWallet().depositFor(recipient, 5e5, type(uint32).max);

        assertEq(PrecompileLib.spotBalance(recipient, QUOTE_TOKEN).total, 0);
        assertFalse(PrecompileLib.coreUserExists(recipient));
    }

    function _coreDepositWallet() internal view returns (ICoreDepositWalletSim) {
        return ICoreDepositWalletSim(HLConstants.coreDepositWallet());
    }

    function _applyFilledResult(uint64 actionId, uint128 cloid, uint64 l1Block) internal {
        CoreSimulatorLib.applyBridgeActionResult(
            actionId,
            alice,
            SPOT_INDEX,
            true,
            BASE_TOKEN,
            QUOTE_TOKEN,
            uint64(2e8),
            uint64(100e8),
            cloid,
            uint8(HyperCore.BridgeActionStatus.FILLED),
            uint8(HyperCore.BridgeReasonCode.NONE),
            l1Block
        );
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
