// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoreExecution} from "./hyper-core/CoreExecution.sol";
import {DoubleEndedQueue} from "@openzeppelin/contracts/utils/structs/DoubleEndedQueue.sol";
import {HLConstants} from "../../src/PrecompileLib.sol";
import {PrecompileLib} from "../../src/PrecompileLib.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {RealL1Read} from "../utils/RealL1Read.sol";

contract HyperCore is CoreExecution {
    using DoubleEndedQueue for DoubleEndedQueue.Bytes32Deque;
    using SafeCast for uint256;

    enum BridgeActionStatus {
        NONE,
        FILLED,
        PARTIAL_FILLED,
        OPEN,
        CANCELED,
        REJECTED,
        UNSUPPORTED,
        ERROR
    }

    enum BridgeReasonCode {
        NONE,
        UNSUPPORTED_KIND,
        DECODE_FAILED,
        SYMBOL_NOT_MAPPED,
        UNSUPPORTED_TIF,
        INSUFFICIENT_BALANCE,
        ORDER_NOT_FOUND,
        ENGINE_ERROR,
        INVALID_ACTION
    }

    struct OrderOutcome {
        uint8 status;
        uint8 reason;
        uint64 l1Block;
        uint64 filledAmount;
        uint64 executionPrice;
    }

    error ActionAlreadyProcessed(uint64 actionId);
    error InsufficientBalance();
    error InvalidBridgeActionStatus(uint8 status);
    error InvalidBridgeReasonCode(uint8 reason);
    error InvalidBridgeOutcomeSemantics(uint8 status, uint8 reason, uint64 filledAmount);

    mapping(uint64 actionId => bool isProcessed) public processedActions;
    mapping(uint128 cloid => OrderOutcome outcome) public orderOutcomes;

    uint64 public simulatedL1BlockNumber;

    event BridgeActionApplied(
        uint64 indexed actionId,
        address indexed sender,
        uint32 indexed spotIndex,
        bool isBuy,
        uint64 filledAmount,
        uint64 executionPrice,
        uint128 cloid,
        uint8 status,
        uint8 reason,
        uint64 l1Block
    );

    event PerpBridgeActionApplied(
        uint64 indexed actionId,
        address indexed sender,
        uint32 indexed perpAsset,
        bool isBuy,
        uint64 filledSz,
        uint64 executionPrice,
        uint128 cloid,
        uint8 status,
        uint8 reason,
        uint64 l1Block
    );

    event SpotSendApplied(
        uint64 indexed actionId,
        address indexed sender,
        address indexed recipient,
        uint64 token,
        uint64 amount,
        uint64 l1Block
    );

    function executeRawAction(address sender, uint24 kind, bytes calldata data) public payable {
        if (kind == HLConstants.LIMIT_ORDER_ACTION) {
            LimitOrderAction memory action = abi.decode(data, (LimitOrderAction));

            // for perps (check that the ID is not a spot asset ID)
            if (action.asset < 1e4 || action.asset >= 1e5) {
                executePerpLimitOrder(sender, action);
            } else {
                executeSpotLimitOrder(sender, action);
            }
            return;
        }

        if (kind == HLConstants.VAULT_TRANSFER_ACTION) {
            executeVaultTransfer(sender, abi.decode(data, (VaultTransferAction)));
            return;
        }

        if (kind == HLConstants.TOKEN_DELEGATE_ACTION) {
            executeTokenDelegate(sender, abi.decode(data, (TokenDelegateAction)));
            return;
        }

        if (kind == HLConstants.STAKING_DEPOSIT_ACTION) {
            executeStakingDeposit(sender, abi.decode(data, (StakingDepositAction)));
            return;
        }

        if (kind == HLConstants.STAKING_WITHDRAW_ACTION) {
            executeStakingWithdraw(sender, abi.decode(data, (StakingWithdrawAction)));
            return;
        }

        if (kind == HLConstants.SPOT_SEND_ACTION) {
            executeSpotSend(sender, abi.decode(data, (SpotSendAction)));
            return;
        }

        if (kind == HLConstants.USD_CLASS_TRANSFER_ACTION) {
            executeUsdClassTransfer(sender, abi.decode(data, (UsdClassTransferAction)));
            return;
        }
    }

    /// @dev unstaking takes 7 days and after which it will automatically appear in the users
    /// spot balance so we need to check this at the end of each operation to simulate that.
    function processStakingWithdrawals() public {
        while (_withdrawQueue.length() > 0) {
            WithdrawRequest memory request = deserializeWithdrawRequest(_withdrawQueue.front());

            if (request.lockedUntilTimestamp > block.timestamp) {
                break;
            }

            _withdrawQueue.popFront();

            _accounts[request.account].spot[HLConstants.hypeTokenIndex()] += request.amount;
        }
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
    ) external {
        BridgeActionStatus bridgeStatus = _validateBridgeOutcome(status, reason, filledAmount);

        _ensureAccountWithToken(sender, baseToken);
        _ensureAccountWithToken(sender, quoteToken);

        _ensureNotProcessed(actionId);
        _markProcessed(actionId, l1Block);

        if (_isStatusWithBalanceUpdate(bridgeStatus)) {
            if (filledAmount > 0) {
                uint64 quoteAmount = ((uint256(filledAmount) * executionPrice) / 1e8).toUint64();
                uint64 feeAmount = (spotMakerFee > 0)
                    ? SafeCast.toUint64((uint256(quoteAmount) * uint256(spotMakerFee)) / FEE_DENOMINATOR)
                    : 0;

                _applyBridgeSpotBalanceUpdate(sender, isBuy, baseToken, quoteToken, filledAmount, quoteAmount, feeAmount);
            }

            if (executionPrice > 0) {
                _spotPrice[spotIndex] = executionPrice;
            }
        }

        if (cloid != 0) {
            orderOutcomes[cloid] = OrderOutcome({
                status: status,
                reason: reason,
                l1Block: l1Block,
                filledAmount: filledAmount,
                executionPrice: executionPrice
            });
        }

        emit BridgeActionApplied(
            actionId, sender, spotIndex, isBuy, filledAmount, executionPrice, cloid, status, reason, l1Block
        );
    }

    /// @notice Applies a perp bridge settlement result, mirroring applyBridgeActionResult for spot.
    /// @dev Validates outcome, ensures the sender's perp account is initialized, marks the action
    ///      as processed, applies perp balance updates (fees + position + PnL) via the shared
    ///      _applyBridgePerpBalanceUpdate, records the order outcome, and emits PerpBridgeActionApplied.
    function applyPerpBridgeActionResult(
        uint64 actionId,
        address sender,
        uint32 perpAsset,
        bool isBuy,
        uint64 filledSz,
        uint64 executionPrice,
        uint128 cloid,
        uint8 status,
        uint8 reason,
        uint64 l1Block
    ) external {
        BridgeActionStatus bridgeStatus = _validateBridgeOutcome(status, reason, filledSz);

        _ensurePerpAccount(sender, uint16(perpAsset));

        _ensureNotProcessed(actionId);
        _markProcessed(actionId, l1Block);

        if (_isStatusWithBalanceUpdate(bridgeStatus)) {
            if (filledSz > 0 && executionPrice > 0) {
                _applyBridgePerpBalanceUpdate(sender, uint16(perpAsset), isBuy, filledSz, executionPrice);
            }

            if (executionPrice > 0) {
                _perpMarkPrice[perpAsset] = executionPrice;
            }
        }

        if (cloid != 0) {
            orderOutcomes[cloid] = OrderOutcome({
                status: status,
                reason: reason,
                l1Block: l1Block,
                filledAmount: filledSz,
                executionPrice: executionPrice
            });
        }

        emit PerpBridgeActionApplied(
            actionId, sender, perpAsset, isBuy, filledSz, executionPrice, cloid, status, reason, l1Block
        );
    }

    /// @dev Ensures the sender account and perp position are initialized for bridge settlement.
    function _ensurePerpAccount(address account, uint16 perpIndex) internal {
        if (!_initializedAccounts[account]) {
            forceAccountActivation(account);
        }

        if (_perpAssetInfo[perpIndex].maxLeverage == 0) {
            registerPerpAssetInfo(perpIndex, RealL1Read.perpAssetInfo(perpIndex));
        }

        if (!_initializedPerpPosition[account][perpIndex]) {
            _initializeAccountWithPerp(account, perpIndex);
        }
    }

    function _applyBridgeSpotBalanceUpdate(
        address sender,
        bool isBuy,
        uint64 baseToken,
        uint64 quoteToken,
        uint64 filledAmount,
        uint64 quoteAmount,
        uint64 feeAmount
    ) internal {
        if (isBuy) {
            uint64 totalDebit = quoteAmount + feeAmount;
            if (_accounts[sender].spot[quoteToken] < totalDebit) {
                revert InsufficientBalance();
            }
            _accounts[sender].spot[quoteToken] -= totalDebit;
            _accounts[sender].spot[baseToken] += filledAmount;
            return;
        }

        if (_accounts[sender].spot[baseToken] < filledAmount) {
            revert InsufficientBalance();
        }
        if (quoteAmount <= feeAmount) {
            revert InsufficientBalance(); // Fee exceeds proceeds
        }

        _accounts[sender].spot[baseToken] -= filledAmount;
        _accounts[sender].spot[quoteToken] += (quoteAmount - feeAmount);
    }

    function applySpotSendAction(
        uint64 actionId,
        address sender,
        address recipient,
        uint64 token,
        uint64 amount,
        uint64 l1Block
    ) external {
        _ensureAccountWithToken(sender, token);
        _ensureAccountWithToken(recipient, token);

        _ensureNotProcessed(actionId);

        if (_accounts[sender].spot[token] < amount) {
            revert InsufficientBalance();
        }

        _accounts[sender].spot[token] -= amount;
        _accounts[recipient].spot[token] += amount;

        _markProcessed(actionId, l1Block);

        emit SpotSendApplied(actionId, sender, recipient, token, amount, l1Block);
    }

    function markBridgeActionProcessed(uint64 actionId, uint8 status, uint8 reason, uint64 l1Block, uint128 cloid)
        external
    {
        BridgeActionStatus bridgeStatus = _validateBridgeOutcome(status, reason, 0);
        if (_isStatusWithBalanceUpdate(bridgeStatus)) {
            revert InvalidBridgeActionStatus(status);
        }

        _ensureNotProcessed(actionId);
        _markProcessed(actionId, l1Block);

        if (cloid != 0) {
            orderOutcomes[cloid] =
                OrderOutcome({status: status, reason: reason, l1Block: l1Block, filledAmount: 0, executionPrice: 0});
        }
    }

    function getOrderOutcome(uint128 cloid)
        external
        view
        returns (uint8 status, uint8 reason, uint64 l1Block, uint64 filledAmount, uint64 executionPrice)
    {
        OrderOutcome memory outcome = orderOutcomes[cloid];
        return (outcome.status, outcome.reason, outcome.l1Block, outcome.filledAmount, outcome.executionPrice);
    }

    function setSimulatedL1BlockNumber(uint64 l1Block) external {
        if (l1Block > simulatedL1BlockNumber) {
            simulatedL1BlockNumber = l1Block;
        }

        if (simulatedL1BlockNumber > _l1BlockNumber) {
            _l1BlockNumber = simulatedL1BlockNumber;
        }
    }

    function registerToken(uint64 index, PrecompileLib.TokenInfo calldata info) external {
        registerTokenInfo(index, info);
    }

    function registerSpotMarket(uint32 index, PrecompileLib.SpotInfo calldata info) external {
        registerSpotInfo(index, info);
    }

    function setSpotBalance(address user, uint64 token, uint64 total, uint64) external {
        forceSpotBalance(user, token, total);
    }

    function setSpotPrice(uint32 spotIndex, uint64 price) external {
        setSpotPx(spotIndex, price);
    }

    function getSpotInfo(uint32 index) external returns (PrecompileLib.SpotInfo memory) {
        return readSpotInfo(index);
    }

    function spotBalances(address user, uint64 token) external returns (uint64) {
        return readSpotBalance(user, token).total;
    }

    function accounts(address user) external view returns (bool activated, uint64 perpBalance, uint64 stakingBalance) {
        return (_accounts[user].activated, _accounts[user].perpBalance, _accounts[user].staking);
    }

    function _ensureNotProcessed(uint64 actionId) internal view {
        if (processedActions[actionId]) {
            revert ActionAlreadyProcessed(actionId);
        }
    }

    function _validateBridgeOutcome(uint8 status, uint8 reason, uint64 filledAmount)
        internal
        pure
        returns (BridgeActionStatus bridgeStatus)
    {
        if (status > uint8(BridgeActionStatus.ERROR) || status == uint8(BridgeActionStatus.NONE)) {
            revert InvalidBridgeActionStatus(status);
        }

        if (reason > uint8(BridgeReasonCode.INVALID_ACTION)) {
            revert InvalidBridgeReasonCode(reason);
        }

        bridgeStatus = BridgeActionStatus(status);
        if (_isStatusWithBalanceUpdate(bridgeStatus)) {
            if (reason != uint8(BridgeReasonCode.NONE)) {
                revert InvalidBridgeOutcomeSemantics(status, reason, filledAmount);
            }
            return bridgeStatus;
        }

        if (reason == uint8(BridgeReasonCode.NONE) || filledAmount > 0) {
            revert InvalidBridgeOutcomeSemantics(status, reason, filledAmount);
        }
    }

    function _isStatusWithBalanceUpdate(BridgeActionStatus status) internal pure returns (bool) {
        return status == BridgeActionStatus.FILLED || status == BridgeActionStatus.PARTIAL_FILLED
            || status == BridgeActionStatus.OPEN;
    }

    function _markProcessed(uint64 actionId, uint64 l1Block) internal {
        processedActions[actionId] = true;

        if (l1Block > simulatedL1BlockNumber) {
            simulatedL1BlockNumber = l1Block;
        }

        if (simulatedL1BlockNumber > _l1BlockNumber) {
            _l1BlockNumber = simulatedL1BlockNumber;
        }
    }

    function _ensureAccountWithToken(address account, uint64 token) internal {
        if (!_initializedSpotBalance[account][token]) {
            registerTokenInfo(token);
            _initializeAccountWithToken(account, token);
        }
    }
}
