// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {HyperCore} from "./HyperCore.sol";
import {CoreWriterSim} from "./CoreWriterSim.sol";
import {PrecompileSim} from "./PrecompileSim.sol";
import {CoreDepositWalletSim} from "./CoreDepositWalletSim.sol";

import {PrecompileLib, HLConstants} from "../../src/PrecompileLib.sol";
import {TokenRegistry} from "../../src/registry/TokenRegistry.sol";

Vm constant vm = Vm(address(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D));
CoreWriterSim constant coreWriter = CoreWriterSim(0x3333333333333333333333333333333333333333);

contract HypeSystemContract {
    receive() external payable {
        coreWriter.nativeTransferCallback{value: msg.value}(msg.sender, msg.sender, msg.value);
    }
}

/**
 * @title CoreSimulatorLib
 * @dev A library used to simulate HyperCore functionality in foundry tests
 */
library CoreSimulatorLib {
    uint256 constant NUM_PRECOMPILES = 17;

    HyperCore constant hyperCore = HyperCore(payable(0x9999999999999999999999999999999999999999));

    struct SpotLimitExecutionData {
        uint64 baseToken;
        uint64 quoteToken;
        uint64 filledAmount;
        uint64 adjustedExecPrice;
        uint64 originalPx;
    }

    struct SpotTokenInfo {
        uint64 baseToken;
        uint64 quoteToken;
        uint8 baseSzDecimals;
        uint8 baseWeiDecimals;
    }

    struct BridgeApplyRequest {
        uint64 actionId;
        address sender;
        uint32 spotMarketId;
        bool isBuy;
        uint64 baseToken;
        uint64 quoteToken;
        uint64 filledAmount;
        uint64 adjustedExecPrice;
        uint128 cloid;
        uint64 l1Block;
    }

    // ERC20 Transfer event signature
    bytes32 constant TRANSFER_EVENT_SIG = keccak256("Transfer(address,address,uint256)");

    function init() internal returns (HyperCore) {
        vm.pauseGasMetering();

        HyperCore coreImpl = new HyperCore();

        vm.etch(address(hyperCore), address(coreImpl).code);

        // Setting storage variables at the etched address
        hyperCore.setStakingYieldIndex(1e18);
        hyperCore.setUseRealL1Read(true);
        hyperCore.setSpotMakerFee(400);
        hyperCore.setPerpMakerFee(150);

        vm.etch(address(coreWriter), type(CoreWriterSim).runtimeCode);
        vm.etch(HLConstants.coreDepositWallet(), type(CoreDepositWalletSim).runtimeCode);

        // Initialize precompiles
        for (uint160 i = 0; i < NUM_PRECOMPILES; i++) {
            address precompileAddress = address(uint160(0x0000000000000000000000000000000000000800) + i);
            vm.etch(precompileAddress, type(PrecompileSim).runtimeCode);
            vm.allowCheatcodes(precompileAddress);
        }

        // System addresses
        address hypeSystemAddress = address(0x2222222222222222222222222222222222222222);
        vm.etch(hypeSystemAddress, type(HypeSystemContract).runtimeCode);

        // Start recording logs for token transfer tracking
        vm.recordLogs();

        vm.allowCheatcodes(address(hyperCore));
        vm.allowCheatcodes(address(coreWriter));
        vm.allowCheatcodes(HLConstants.coreDepositWallet());

        // if offline mode, deploy the TokenRegistry and register main tokens
        if (!isForkActive()) {
            _deployTokenRegistryAndCoreTokens();
        }

        vm.resumeGasMetering();

        return hyperCore;
    }

    /**
     * @notice Advances the simulation by one block.
     * @dev Processing order:
     *   1. ERC20 transfers to system addresses (EVM->Core)
     *   2. Block number + timestamp advance
     *   3. Liquidate positions
     *   4. Process callback queue (token/native transfers via priority queue)
     *   5. Process ring buffer with ADR-018 auto-apply (spot→bridge, sends→spotSend, rest→rawAction)
     *   6. Process pending orders
     * @param expectRevert If true, do not revert on action failures and instead return
     *        whether any queued action failed.
     */
    function nextBlock(bool expectRevert) internal {
        // Get all recorded logs
        Vm.Log[] memory entries = vm.getRecordedLogs();

        // Process any ERC20 transfers to system addresses (EVM->Core transfers are processed before CoreWriter actions)
        for (uint256 i = 0; i < entries.length; i++) {
            Vm.Log memory entry = entries[i];

            // Check if it's a Transfer event
            if (entry.topics[0] == TRANSFER_EVENT_SIG) {
                address from = address(uint160(uint256(entry.topics[1])));
                address to = address(uint160(uint256(entry.topics[2])));
                uint256 amount = abi.decode(entry.data, (uint256));


                // Check if destination is the token's system address
                if (isSystemAddress(entry.emitter, to)) {
                    uint64 tokenIndex = getTokenIndexFromSystemAddress(to);

                    if (tokenIndex != 150) hyperCore.executeTokenTransfer(address(0), tokenIndex, from, amount);
                }
            }
        }

        // Clear recorded logs for next block
        vm.recordLogs();

        // Advance block
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);

        // liquidate any positions that are liquidatable
        hyperCore.liquidatePositions();

        // Process callback queue first for bridge-credit-dependent flows
        coreWriter.executeQueuedActions(false);

        // Process ring-buffer raw actions through HyperCore.executeRawAction
        bool ringFail = _autoApplyQueuedActions(expectRevert);
        if (expectRevert && !ringFail) {
            revert("Expected revert, but action succeeded");
        }

        // Process pending orders
        hyperCore.processPendingOrders();
    }

    /**
     * @notice Drains queued ring-buffer actions and auto-applies them via ADR-018 routing.
     * @dev Spot limit orders route through `applyBridgeActionResult(FILLED)` with fee-adjusted
     *      execution price. Spot sends route through `applySpotSendAction()`. Everything else
     *      (perps, vaults, staking, delegation, non-executable spot orders) falls back to
     *      `executeRawAction()`.
     * @param expectRevert If true, treat execution failures as soft failures instead of revert.
     * @return anyFail True when any queued action execution fails.
     */
    function _autoApplyQueuedActions(bool expectRevert) internal returns (bool anyFail) {
        uint256 queueLength = coreWriter.getQueueLength();
        if (queueLength == 0) {
            return false;
        }

        CoreWriterSim.QueuedAction[] memory queuedActions = coreWriter.getQueuedActions(0, queueLength);
        coreWriter.consumeQueuedActions(queueLength);

        bool shouldRevertOnFailure = coreWriter.revertOnFailure();

        for (uint256 i = 0; i < queuedActions.length; i++) {
            CoreWriterSim.QueuedAction memory action = queuedActions[i];
            bool success;
            bool shouldExecuteRawAction = true;

            if (action.kind == HLConstants.LIMIT_ORDER_ACTION) {
                (bool handled, bool routeSuccess) = _tryApplySpotLimitOrderAction(action);
                if (handled) {
                    shouldExecuteRawAction = false;
                    success = routeSuccess;
                }
            } else if (action.kind == HLConstants.SPOT_SEND_ACTION) {
                (bool handled, bool routeSuccess) = _tryApplySpotSendAction(action);
                if (handled) {
                    shouldExecuteRawAction = false;
                    success = routeSuccess;
                }
            }

            if (shouldExecuteRawAction) {
                (success,) = address(hyperCore).call(
                    abi.encodeCall(HyperCore.executeRawAction, (action.sender, action.kind, action.payload))
                );
            }

            if (!success) {
                anyFail = true;

                if (shouldRevertOnFailure && !expectRevert) {
                    revert("CoreWriter action failed: Reverting due to revertOnFailure flag");
                }
            }
        }
    }

    function _tryApplySpotLimitOrderAction(CoreWriterSim.QueuedAction memory action)
        private
        returns (bool handled, bool success)
    {
        (bool decoded, uint32 spotMarketId, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid) =
            _decodeSpotLimitOrderPayload(action.payload);
        if (!decoded) {
            return (false, false);
        }

        (bool canApplyBridge, SpotLimitExecutionData memory executionData) =
            _prepareSpotLimitBridgeExecution(spotMarketId, isBuy, limitPx, sz);
        if (!canApplyBridge) {
            return (false, false);
        }

        BridgeApplyRequest memory request = BridgeApplyRequest({
            actionId: action.actionId,
            sender: action.sender,
            spotMarketId: spotMarketId,
            isBuy: isBuy,
            baseToken: executionData.baseToken,
            quoteToken: executionData.quoteToken,
            filledAmount: executionData.filledAmount,
            adjustedExecPrice: executionData.adjustedExecPrice,
            cloid: cloid,
            l1Block: action.l1Block
        });

        success = _applyBridgeActionResultLowLevel(request);
        if (success) {
            hyperCore.setSpotPx(spotMarketId, executionData.originalPx);
        }

        return (true, success);
    }

    function _decodeSpotLimitOrderPayload(bytes memory payload)
        private
        pure
        returns (bool decoded, uint32 spotMarketId, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid)
    {
        if (payload.length != 224) {
            return (false, 0, false, 0, 0, 0);
        }

        uint32 asset;
        (asset, isBuy, limitPx, sz,,, cloid) = abi.decode(payload, (uint32, bool, uint64, uint64, bool, uint8, uint128));

        bool isSpotAsset = asset >= 1e4 && asset < 1e5;
        if (!isSpotAsset || sz == 0) {
            return (false, 0, false, 0, 0, 0);
        }

        spotMarketId = asset - 10000;
        return (true, spotMarketId, isBuy, limitPx, sz, cloid);
    }

    function _prepareSpotLimitBridgeExecution(uint32 spotMarketId, bool isBuy, uint64 limitPx, uint64 sz)
        private
        returns (bool canApplyBridge, SpotLimitExecutionData memory executionData)
    {
        (bool lookupSuccess, SpotTokenInfo memory spotTokenInfo) = _tryReadSpotAndBaseTokenInfo(spotMarketId);
        if (!lookupSuccess) {
            return (false, executionData);
        }

        (bool hasSpotPx, uint64 originalPx, uint64 spotPx) =
            _tryGetSpotPxForBridge(spotMarketId, spotTokenInfo.baseSzDecimals);
        if (!hasSpotPx) {
            return (false, executionData);
        }

        bool executable = isBuy ? limitPx >= spotPx : limitPx <= spotPx;
        if (!executable) {
            return (false, executionData);
        }

        (bool hasAmounts, uint64 filledAmount, uint64 adjustedExecPrice) =
            _tryPrepareBridgeAmounts(isBuy, sz, spotPx, spotTokenInfo.baseWeiDecimals);
        if (!hasAmounts) {
            return (false, executionData);
        }

        executionData.baseToken = spotTokenInfo.baseToken;
        executionData.quoteToken = spotTokenInfo.quoteToken;
        executionData.filledAmount = filledAmount;
        executionData.adjustedExecPrice = adjustedExecPrice;
        executionData.originalPx = originalPx;
        return (true, executionData);
    }

    function _tryGetSpotPxForBridge(uint32 spotMarketId, uint8 baseSzDecimals)
        private
        returns (bool hasSpotPx, uint64 originalPx, uint64 spotPx)
    {
        originalPx = hyperCore.readSpotPx(spotMarketId);
        spotPx = originalPx * SafeCast.toUint64(10 ** baseSzDecimals);

        if (spotPx == 0 && !hyperCore.useRealL1Read()) {
            // Preserve executeSpotLimitOrder's offline-mode revert path via executeRawAction fallback.
            return (false, 0, 0);
        }

        return (true, originalPx, spotPx);
    }

    function _tryPrepareBridgeAmounts(bool isBuy, uint64 sz, uint64 spotPx, uint8 baseWeiDecimals)
        private
        returns (bool hasAmounts, uint64 filledAmount, uint64 adjustedExecPrice)
    {
        filledAmount = _scale(sz, 8, baseWeiDecimals);
        if (filledAmount == 0) {
            return (false, 0, 0);
        }

        (bool hasAdjustedExecPrice, uint64 computedAdjustedExecPrice) =
            _computeAdjustedExecPrice(isBuy, sz, spotPx, filledAmount, hyperCore.spotMakerFee());
        if (!hasAdjustedExecPrice) {
            return (false, 0, 0);
        }

        return (true, filledAmount, computedAdjustedExecPrice);
    }

    function _applyBridgeActionResultLowLevel(BridgeApplyRequest memory request) private returns (bool success) {
        (success,) = address(hyperCore).call(
            abi.encodeCall(
                HyperCore.applyBridgeActionResult,
                (
                    request.actionId,
                    request.sender,
                    request.spotMarketId,
                    request.isBuy,
                    request.baseToken,
                    request.quoteToken,
                    request.filledAmount,
                    request.adjustedExecPrice,
                    request.cloid,
                    uint8(1),
                    uint8(0),
                    request.l1Block
                )
            )
        );
    }

    function _tryApplySpotSendAction(CoreWriterSim.QueuedAction memory action)
        private
        returns (bool handled, bool success)
    {
        if (action.payload.length != 96) {
            return (false, false);
        }

        (address destination, uint64 token, uint64 amountWei) = abi.decode(action.payload, (address, uint64, uint64));

        // Bridge-to-EVM spot sends must use executeRawAction -> executeSpotSend to trigger EVM transfer callbacks.
        if (getTokenIndexFromSystemAddress(destination) == token) {
            return (false, false);
        }

        (success,) = address(hyperCore).call(
            abi.encodeCall(
                HyperCore.applySpotSendAction,
                (action.actionId, action.sender, destination, token, amountWei, action.l1Block)
            )
        );

        return (true, success);
    }

    function _tryReadSpotAndBaseTokenInfo(uint32 spotMarketId)
        private
        view
        returns (bool lookupSuccess, SpotTokenInfo memory spotTokenInfo)
    {
        (bool spotInfoSuccess, bytes memory spotInfoData) =
            HLConstants.SPOT_INFO_PRECOMPILE_ADDRESS.staticcall(abi.encode(uint64(spotMarketId)));
        if (!spotInfoSuccess) {
            return (false, spotTokenInfo);
        }

        PrecompileLib.SpotInfo memory spotInfo = abi.decode(spotInfoData, (PrecompileLib.SpotInfo));
        spotTokenInfo.baseToken = spotInfo.tokens[0];
        spotTokenInfo.quoteToken = spotInfo.tokens[1];

        (bool tokenInfoSuccess, bytes memory tokenInfoData) =
            HLConstants.TOKEN_INFO_PRECOMPILE_ADDRESS.staticcall(abi.encode(spotTokenInfo.baseToken));
        if (!tokenInfoSuccess) {
            return (false, spotTokenInfo);
        }

        PrecompileLib.TokenInfo memory baseTokenInfo = abi.decode(tokenInfoData, (PrecompileLib.TokenInfo));
        spotTokenInfo.baseSzDecimals = baseTokenInfo.szDecimals;
        spotTokenInfo.baseWeiDecimals = baseTokenInfo.weiDecimals;
        return (true, spotTokenInfo);
    }

    function _computeAdjustedExecPrice(bool isBuy, uint64 sz, uint64 spotPx, uint64 filledAmount, uint16 spotMakerFee)
        private
        pure
        returns (bool canApplyBridge, uint64 adjustedExecPrice)
    {
        if (isBuy) {
            uint64 amountIn = SafeCast.toUint64((uint256(sz) * uint256(spotPx)) / 1e8);
            uint64 totalDebit = amountIn;

            if (spotMakerFee > 0) {
                totalDebit = SafeCast.toUint64(uint256(amountIn) + ((uint256(amountIn) * uint256(spotMakerFee)) / 1e6));
            }

            // Assumes filledAmount == sz for current test tokens (weiDecimals == 8).
            adjustedExecPrice = SafeCast.toUint64((uint256(totalDebit) * 1e8) / uint256(filledAmount));
            return (true, adjustedExecPrice);
        }

        uint64 amountOut = SafeCast.toUint64((uint256(sz) * uint256(spotPx)) / 1e8);
        uint64 netProceeds = amountOut;

        if (spotMakerFee > 0) {
            uint64 fee = SafeCast.toUint64((uint256(amountOut) * uint256(spotMakerFee)) / 1e6);
            if (netProceeds <= fee) {
                return (false, 0);
            }
            netProceeds -= fee;
        }

        adjustedExecPrice = SafeCast.toUint64((uint256(netProceeds) * 1e8) / uint256(filledAmount));
        return (true, adjustedExecPrice);
    }

    /**
     * @notice Scales a uint64 amount between decimal representations.
     * @dev Mirrors CoreExecution.scale() exactly for consistency.
     */
    function _scale(uint64 amount, uint8 fromDecimals, uint8 toDecimals) private pure returns (uint64) {
        if (fromDecimals == toDecimals) {
            return amount;
        } else if (fromDecimals < toDecimals) {
            uint8 diff = toDecimals - fromDecimals;
            return amount * uint64(10) ** diff;
        } else {
            uint8 diff = fromDecimals - toDecimals;
            return amount / (uint64(10) ** diff);
        }
    }

    function nextBlock() internal {
        nextBlock(false);
    }

    ////// Testing Config Setters /////////

    function setRevertOnFailure(bool _revertOnFailure) internal {
        coreWriter.setRevertOnFailure(_revertOnFailure);
    }

    /**
     * @notice Compatibility shim retained for legacy callers.
     * @dev Forwards `mode` to the underlying CoreWriter simulation to preserve historical call paths.
     *      ADR-018 processing still assumes queue-mode routing for raw actions.
     * @param mode Target mode value for CoreWriter.
     */
    function setCoreWriterMode(CoreWriterSim.Mode mode) internal {
        coreWriter.setMode(mode);
    }

    /**
     * @notice Compatibility shim retained for legacy callers.
     * @dev Sets queue mode explicitly to align with ADR-018 default routing behavior.
     */
    function setCoreWriterQueueMode() internal {
        coreWriter.setMode(CoreWriterSim.Mode.QUEUE);
    }

    function getQueuedActionCount() internal view returns (uint256) {
        return coreWriter.getQueueLength();
    }

    function getQueuedActions(uint256 offset, uint256 limit)
        internal
        view
        returns (CoreWriterSim.QueuedAction[] memory)
    {
        return coreWriter.getQueuedActions(offset, limit);
    }

    function consumeQueuedActions(uint256 count) internal {
        coreWriter.consumeQueuedActions(count);
    }

    function applyBridgeActionResult(
        uint64 actionId,
        address sender,
        uint32 spotIndex,
        bool isBuy,
        uint64 baseToken,
        uint64 quoteToken,
        uint64 filledAmount,
        uint64 executionPrice,
        uint128 cloid,
        uint8 status,
        uint8 reason,
        uint64 l1Block
    ) internal {
        hyperCore.applyBridgeActionResult(
            actionId,
            sender,
            spotIndex,
            isBuy,
            baseToken,
            quoteToken,
            filledAmount,
            executionPrice,
            cloid,
            status,
            reason,
            l1Block
        );
    }

    function applySpotSendAction(
        uint64 actionId,
        address sender,
        address recipient,
        uint64 token,
        uint64 amount,
        uint64 l1Block
    ) internal {
        hyperCore.applySpotSendAction(actionId, sender, recipient, token, amount, l1Block);
    }

    function markBridgeActionProcessed(uint64 actionId, uint8 status, uint8 reason, uint64 l1Block, uint128 cloid)
        internal
    {
        hyperCore.markBridgeActionProcessed(actionId, status, reason, l1Block, cloid);
    }

    function setSimulatedL1BlockNumber(uint64 l1Block) internal {
        hyperCore.setSimulatedL1BlockNumber(l1Block);
    }

    // cheatcodes //
    function forceAccountActivation(address account) internal {
        hyperCore.forceAccountActivation(account);
    }

    function setOfflineMode(bool isOffline) internal {
        hyperCore.setUseRealL1Read(!isOffline);
        vm.warp(vm.unixTime() / 1e3);
    }

    function forceSpotBalance(address account, uint64 token, uint64 _wei) internal {
        hyperCore.forceSpotBalance(account, token, _wei);
    }

    function forcePerpBalance(address account, uint64 usd) internal {
        hyperCore.forcePerpBalance(account, usd);
    }

    function forceStakingBalance(address account, uint64 _wei) internal {
        hyperCore.forceStakingBalance(account, _wei);
    }

    function forceDelegation(address account, address validator, uint64 amount, uint64 lockedUntilTimestamp) internal {
        hyperCore.forceDelegation(account, validator, amount, lockedUntilTimestamp);
    }

    function forceVaultEquity(address account, address vault, uint64 usd, uint64 lockedUntilTimestamp) internal {
        hyperCore.forceVaultEquity(account, vault, usd, lockedUntilTimestamp);
    }

    function setMarkPx(uint32 perp, uint64 markPx) internal {
        hyperCore.setMarkPx(perp, markPx);
    }

    function setMarkPx(uint32 perp, uint64 priceDiffBps, bool isIncrease) internal {
        hyperCore.setMarkPx(perp, priceDiffBps, isIncrease);
    }

    function setSpotPx(uint32 spotMarketId, uint64 spotPx) internal {
        hyperCore.setSpotPx(spotMarketId, spotPx);
    }

    function setSpotPx(uint32 spotMarketId, uint64 priceDiffBps, bool isIncrease) internal {
        hyperCore.setSpotPx(spotMarketId, priceDiffBps, isIncrease);
    }

    function setVaultMultiplier(address vault, uint64 multiplier) internal {
        hyperCore.setVaultMultiplier(vault, multiplier);
    }

    function setStakingYieldIndex(uint64 multiplier) internal {
        hyperCore.setStakingYieldIndex(multiplier);
    }

    function setSpotMakerFee(uint16 bps) internal {
        hyperCore.setSpotMakerFee(bps);
    }

    function setPerpMakerFee(uint16 bps) internal {
        hyperCore.setPerpMakerFee(bps);
    }

    function setL1BlockNumber(uint64 blockNum) internal {
        hyperCore.setL1BlockNumber(blockNum);
    }

    function setTokenSupply(
        uint64 token,
        uint64 maxSupply,
        uint64 totalSupply,
        uint64 circulatingSupply,
        uint64 futureEmissions
    ) internal {
        hyperCore.setTokenSupply(token, maxSupply, totalSupply, circulatingSupply, futureEmissions);
    }

    function setBbo(uint64 asset, uint64 bid, uint64 ask) internal {
        hyperCore.setBbo(asset, bid, ask);
    }

    function forcePerpLeverage(address account, uint16 perp, uint32 leverage) internal {
        hyperCore.forcePerpPositionLeverage(account, perp, leverage);
    }

    ///// Private Functions /////
    function _deployTokenRegistryAndCoreTokens() private {
        TokenRegistry registry = TokenRegistry(0x0b51d1A9098cf8a72C325003F44C194D41d7A85B);
        vm.etch(address(registry), type(TokenRegistry).runtimeCode);

        // register HYPE in hyperCore
        uint64[] memory hypeSpots = new uint64[](3);
        hypeSpots[0] = 107;
        hypeSpots[1] = 207;
        hypeSpots[2] = 232;
        PrecompileLib.TokenInfo memory hypeTokenInfo = PrecompileLib.TokenInfo({
            name: "HYPE",
            spots: hypeSpots,
            deployerTradingFeeShare: 0,
            deployer: address(0),
            evmContract: address(0),
            szDecimals: 2,
            weiDecimals: 8,
            evmExtraWeiDecimals: 0
        });
        hyperCore.registerTokenInfo(150, hypeTokenInfo);

        // register USDC in hyperCore
        uint64[] memory usdcSpots = new uint64[](0);
        PrecompileLib.TokenInfo memory usdcTokenInfo = PrecompileLib.TokenInfo({
            name: "USDC",
            spots: usdcSpots,
            deployerTradingFeeShare: 0,
            deployer: address(0),
            evmContract: address(0),
            szDecimals: 8,
            weiDecimals: 8,
            evmExtraWeiDecimals: 0
        });
        hyperCore.registerTokenInfo(0, usdcTokenInfo);

        // register USDT in hyperCore
        address usdt0 = 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb;

        Token usdt0Token = new Token();
        vm.etch(usdt0, address(usdt0Token).code);

        uint64[] memory usdt0Spots = new uint64[](1);
        usdt0Spots[0] = 166;
        PrecompileLib.TokenInfo memory usdtTokenInfo = PrecompileLib.TokenInfo({
            name: "USDT0",
            spots: usdt0Spots,
            deployerTradingFeeShare: 0,
            deployer: 0x1a6362AD64ccFF5902D46D875B36e8798267d154,
            evmContract: usdt0,
            szDecimals: 2,
            weiDecimals: 8,
            evmExtraWeiDecimals: -2
        });
        hyperCore.registerTokenInfo(268, usdtTokenInfo);
        registry.setTokenInfo(268);

        // register spot markets
        PrecompileLib.SpotInfo memory hypeSpotInfo =
            PrecompileLib.SpotInfo({name: "@107", tokens: [uint64(150), uint64(0)]});
        hyperCore.registerSpotInfo(107, hypeSpotInfo);

        PrecompileLib.SpotInfo memory usdt0SpotInfo =
            PrecompileLib.SpotInfo({name: "@166", tokens: [uint64(268), uint64(0)]});
        hyperCore.registerSpotInfo(166, usdt0SpotInfo);

        // register HYPE perp info
        PrecompileLib.PerpAssetInfo memory hypePerpAssetInfo = PrecompileLib.PerpAssetInfo({
            coin: "HYPE", marginTableId: 52, szDecimals: 2, maxLeverage: 10, onlyIsolated: false
        });
        hyperCore.registerPerpAssetInfo(150, hypePerpAssetInfo);
    }

    ///// VIEW AND PURE /////////

    function isSystemAddress(address emitter, address addr) internal view returns (bool) {

        // Check if it's a token system address (0x2000...0000 + index)
        uint160 baseAddr = uint160(0x2000000000000000000000000000000000000000);
        uint160 addrInt = uint160(addr);

        if (addrInt >= baseAddr && addrInt < baseAddr + 10000) {
            uint64 tokenIndex = uint64(addrInt - baseAddr);

            PrecompileLib.TokenInfo memory tokenInfo = PrecompileLib.tokenInfo(tokenIndex);
            if (addr != tokenInfo.evmContract) return false;
        }

        return false;
    }

    function getTokenIndexFromSystemAddress(address systemAddr) internal pure returns (uint64) {
        if (systemAddr == address(0x2222222222222222222222222222222222222222)) {
            return 150; // HYPE token index
        }

        if (uint160(systemAddr) < uint160(0x2000000000000000000000000000000000000000)) return type(uint64).max;

        return uint64(uint160(systemAddr) - uint160(0x2000000000000000000000000000000000000000));
    }

    function tokenExists(uint64 token) internal view returns (bool) {
        (bool success,) = HLConstants.TOKEN_INFO_PRECOMPILE_ADDRESS.staticcall(abi.encode(token));
        return success;
    }

    /// @dev Make an address persistent to prevent RPC storage calls
    /// Call this for any test addresses you create/etch to prevent RPC calls
    function makeAddressPersistent(address addr) internal {
        vm.makePersistent(addr);
        vm.deal(addr, 1 wei); // Ensure it "exists" in the fork
    }

    function isForkActive() internal view returns (bool) {
        try vm.activeFork() returns (uint256) {
            return true; // Fork is active
        } catch {
            return false; // No fork active
        }
    }
}

contract Token is ERC20 {
    constructor() ERC20("USDT0", "USDT0") {}
}
