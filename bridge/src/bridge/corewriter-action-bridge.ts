import { decodeAbiParameters, encodeFunctionData } from 'viem';

import type { MatchingEngine } from '../engine/matching-engine.js';
import { Logger } from '../logging/logger.js';
import type { CoreWriterActionBridgeConfig } from '../types/config.js';
import type { AnvilBridge } from './anvil-bridge.js';

const logger = new Logger('corewriter-action-bridge');

const LIMIT_ORDER_ACTION = 1;
const SPOT_SEND_ACTION = 6;
const CANCEL_ORDER_BY_OID_ACTION = 10;
const CANCEL_ORDER_BY_CLOID_ACTION = 11;
const SPOT_ASSET_OFFSET = 10_000;

const STATUS = {
  FILLED: 1,
  PARTIAL_FILLED: 2,
  OPEN: 3,
  CANCELED: 4,
  REJECTED: 5,
  UNSUPPORTED: 6,
  ERROR: 7,
} as const;

const REASON = {
  NONE: 0,
  UNSUPPORTED_KIND: 1,
  DECODE_FAILED: 2,
  SYMBOL_NOT_MAPPED: 3,
  UNSUPPORTED_TIF: 4,
  INSUFFICIENT_BALANCE: 5,
  ORDER_NOT_FOUND: 6,
  ENGINE_ERROR: 7,
  INVALID_ACTION: 8,
} as const;

const coreWriterAbi = [
  {
    type: 'function',
    name: 'getQueueLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getQueuedActions',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'actionId', type: 'uint64' },
          { name: 'sender', type: 'address' },
          { name: 'kind', type: 'uint24' },
          { name: 'payload', type: 'bytes' },
          { name: 'l1Block', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'consumeQueuedActions',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'count', type: 'uint256' }],
    outputs: [],
  },
] as const;

const hyperCoreAbi = [
  {
    type: 'function',
    name: 'getSpotInfo',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'tokens', type: 'uint64[2]' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'processedActions',
    stateMutability: 'view',
    inputs: [{ name: 'actionId', type: 'uint64' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'spotBalances',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'uint64' },
    ],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'applyBridgeActionResult',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'actionId', type: 'uint64' },
      { name: 'sender', type: 'address' },
      { name: 'spotIndex', type: 'uint32' },
      { name: 'isBuy', type: 'bool' },
      { name: 'baseToken', type: 'uint64' },
      { name: 'quoteToken', type: 'uint64' },
      { name: 'filledAmount', type: 'uint64' },
      { name: 'executionPrice', type: 'uint64' },
      { name: 'cloid', type: 'uint128' },
      { name: 'status', type: 'uint8' },
      { name: 'reason', type: 'uint8' },
      { name: 'l1Block', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'applySpotSendAction',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'actionId', type: 'uint64' },
      { name: 'sender', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'token', type: 'uint64' },
      { name: 'amount', type: 'uint64' },
      { name: 'l1Block', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'applyPerpBridgeActionResult',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'actionId', type: 'uint64' },
      { name: 'sender', type: 'address' },
      { name: 'perpAsset', type: 'uint32' },
      { name: 'isBuy', type: 'bool' },
      { name: 'filledSz', type: 'uint64' },
      { name: 'executionPrice', type: 'uint64' },
      { name: 'cloid', type: 'uint128' },
      { name: 'status', type: 'uint8' },
      { name: 'reason', type: 'uint8' },
      { name: 'l1Block', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'markBridgeActionProcessed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'actionId', type: 'uint64' },
      { name: 'status', type: 'uint8' },
      { name: 'reason', type: 'uint8' },
      { name: 'l1Block', type: 'uint64' },
      { name: 'cloid', type: 'uint128' },
    ],
    outputs: [],
  },
] as const;

type QueuedAction = {
  actionId: bigint;
  sender: `0x${string}`;
  kind: number;
  payload: `0x${string}`;
  l1Block: bigint;
};

type SyncResult = {
  processed: number;
  applied: number;
  failed: number;
  queueLength: number;
};

export class CoreWriterActionBridge {
  private readonly spotTokenCache = new Map<number, { baseToken: bigint; quoteToken: bigint }>();
  private intervalId: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    private readonly bridge: AnvilBridge,
    private readonly engine: MatchingEngine,
    private readonly config: CoreWriterActionBridgeConfig
  ) {}

  start(): void {
    if (!this.config.enabled || this.config.mode !== 'interval') {
      return;
    }

    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      void this.syncOnce();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (!this.intervalId) {
      return;
    }

    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async syncOnce(): Promise<SyncResult> {
    if (this.syncing) {
      return { processed: 0, applied: 0, failed: 0, queueLength: 0 };
    }

    this.syncing = true;

    try {
      const queueLengthRaw = await this.bridge.publicClient.readContract({
        address: this.config.coreWriterAddress,
        abi: coreWriterAbi,
        functionName: 'getQueueLength',
      });
      const queueLength = Number(queueLengthRaw);

      if (queueLength === 0) {
        return { processed: 0, applied: 0, failed: 0, queueLength };
      }

      const actionsRaw = await this.bridge.publicClient.readContract({
        address: this.config.coreWriterAddress,
        abi: coreWriterAbi,
        functionName: 'getQueuedActions',
        args: [0n, BigInt(queueLength)],
      });

      const actions = this.normalizeQueuedActions(actionsRaw);
      let processed = 0;
      let applied = 0;
      let failed = 0;
      let consumableCount = 0;

      for (const action of actions) {
        processed += 1;
        const success = await this.processAction(action);
        if (success) {
          applied += 1;
          consumableCount += 1;
        } else {
          failed += 1;
          break;
        }
      }

      if (consumableCount > 0) {
        const consumed = await this.sendTransaction(
          this.config.coreWriterAddress,
          encodeFunctionData({
            abi: coreWriterAbi,
            functionName: 'consumeQueuedActions',
            args: [BigInt(consumableCount)],
          })
        );

        if (!consumed) {
          logger.warn('failed to consume queued actions', {
            queueLength,
            consumableCount,
          });
        }
      }

      return {
        processed,
        applied,
        failed,
        queueLength,
      };
    } finally {
      this.syncing = false;
    }
  }

  private normalizeQueuedActions(raw: unknown): QueuedAction[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((entry) => {
        if (Array.isArray(entry)) {
          const [actionId, sender, kind, payload, l1Block] = entry;
          return {
            actionId: actionId as bigint,
            sender: sender as `0x${string}`,
            kind: Number(kind),
            payload: payload as `0x${string}`,
            l1Block: l1Block as bigint,
          };
        }

        if (entry && typeof entry === 'object') {
          const value = entry as Record<string, unknown>;
          return {
            actionId: value.actionId as bigint,
            sender: value.sender as `0x${string}`,
            kind: Number(value.kind),
            payload: value.payload as `0x${string}`,
            l1Block: value.l1Block as bigint,
          };
        }

        return null;
      })
      .filter((entry): entry is QueuedAction => entry !== null);
  }

  private async processAction(action: QueuedAction): Promise<boolean> {
    const alreadyProcessed = await this.bridge.publicClient.readContract({
      address: this.config.hyperCoreAddress,
      abi: hyperCoreAbi,
      functionName: 'processedActions',
      args: [action.actionId],
    });

    if (alreadyProcessed) {
      return true;
    }

    if (action.kind === LIMIT_ORDER_ACTION) {
      return this.processLimitOrderAction(action);
    }

    if (action.kind === CANCEL_ORDER_BY_OID_ACTION) {
      return this.processCancelByOidAction(action);
    }

    if (action.kind === CANCEL_ORDER_BY_CLOID_ACTION) {
      return this.processCancelByCloidAction(action);
    }

    if (action.kind === SPOT_SEND_ACTION) {
      return this.processSpotSendAction(action);
    }

    return this.markProcessed(action, STATUS.UNSUPPORTED, REASON.UNSUPPORTED_KIND, 0n);
  }

  private isSpotAsset(asset: number): boolean {
    return asset >= SPOT_ASSET_OFFSET && asset < 100_000;
  }

  private async processLimitOrderAction(action: QueuedAction): Promise<boolean> {
    let decodedClOid = 0n;
    let asset = 0;
    let isBuy = false;
    let limitPxRaw = 0n;
    let sizeRaw = 0n;
    let tifRaw = 0;

    try {
      const [assetRaw, decodedIsBuy, decodedLimitPxRaw, decodedSizeRaw, , decodedTifRaw, cloidRaw] = decodeAbiParameters(
        [
          { type: 'uint32' },
          { type: 'bool' },
          { type: 'uint64' },
          { type: 'uint64' },
          { type: 'bool' },
          { type: 'uint8' },
          { type: 'uint128' },
        ],
        action.payload
      );

      decodedClOid = cloidRaw;
      asset = Number(assetRaw);
      isBuy = decodedIsBuy;
      limitPxRaw = decodedLimitPxRaw;
      sizeRaw = decodedSizeRaw;
      tifRaw = decodedTifRaw;
    } catch (error) {
      logger.warn('failed to decode limit order action payload', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.DECODE_FAILED, 0n);
    }

    try {
      const cloidRaw = decodedClOid;

      if (!this.isSpotAsset(asset)) {
        return this.processPerpLimitOrderAction(action, asset, isBuy, limitPxRaw, sizeRaw, tifRaw, decodedClOid);
      }

      const spotIndex = asset - SPOT_ASSET_OFFSET;
      const symbol = this.config.marketMap[String(spotIndex)];
      if (!symbol) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.SYMBOL_NOT_MAPPED, cloidRaw);
      }

      const tif = this.mapTimeInForce(tifRaw);
      if (!tif) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.UNSUPPORTED_TIF, cloidRaw);
      }

      const quantity = this.toSafeInteger(sizeRaw);
      const price = this.toSafeInteger(limitPxRaw);

      if (quantity === null || price === null || quantity <= 0 || price <= 0) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.INVALID_ACTION, cloidRaw);
      }

      const spotTokens = await this.getSpotTokens(spotIndex);
      if (!spotTokens) {
        return this.markProcessed(action, STATUS.ERROR, REASON.ENGINE_ERROR, cloidRaw);
      }

      const hasSufficientBalance = await this.hasSufficientLimitOrderBalance(
        action.sender,
        isBuy,
        sizeRaw,
        limitPxRaw,
        spotTokens
      );
      if (!hasSufficientBalance) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.INSUFFICIENT_BALANCE, cloidRaw);
      }

      const orderId = cloidRaw.toString();
      const submitResult = await this.engine.submitOrder({
        id: orderId,
        symbol,
        userId: action.sender.toLowerCase(),
        side: isBuy ? 'buy' : 'sell',
        kind: 'limit',
        quantity,
        price,
        timeInForce: tif,
      });

      const fills = submitResult.trades.filter(
        (trade) => trade.takerOrderId === orderId || trade.makerOrderId === orderId
      );

      const filledQuantity = fills.reduce((sum, trade) => sum + trade.quantity, 0);
      const weightedNotional = fills.reduce((sum, trade) => sum + trade.quantity * trade.price, 0);
      const executionPrice = filledQuantity > 0 ? Math.round(weightedNotional / filledQuantity) : 0;

      const outcome = this.mapLimitOrderOutcome(submitResult.order.status, this.extractOrderReason(submitResult), filledQuantity);
      const status = outcome.status;
      const reason = outcome.reason;

      if (filledQuantity === 0 || executionPrice === 0) {
        return this.markProcessed(action, status, reason, cloidRaw);
      }

      return this.sendTransaction(
        this.config.hyperCoreAddress,
        encodeFunctionData({
          abi: hyperCoreAbi,
          functionName: 'applyBridgeActionResult',
          args: [
            action.actionId,
            action.sender,
            spotIndex,
            isBuy,
            spotTokens.baseToken,
            spotTokens.quoteToken,
            BigInt(Math.round(filledQuantity)),
            BigInt(executionPrice),
            cloidRaw,
            status,
            reason,
            action.l1Block,
          ],
        })
      );
    } catch (error) {
      logger.warn('failed to process limit order action', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.ENGINE_ERROR, decodedClOid);
    }
  }

  private async processPerpLimitOrderAction(
    action: QueuedAction,
    perpAsset: number,
    isBuy: boolean,
    limitPxRaw: bigint,
    sizeRaw: bigint,
    tifRaw: number,
    cloidRaw: bigint
  ): Promise<boolean> {
    const perpMarketMap = this.config.perpMarketMap ?? {};
    const symbol = perpMarketMap[String(perpAsset)];
    if (!symbol) {
      return this.markProcessed(action, STATUS.REJECTED, REASON.SYMBOL_NOT_MAPPED, cloidRaw);
    }

    const tif = this.mapTimeInForce(tifRaw);
    if (!tif) {
      return this.markProcessed(action, STATUS.REJECTED, REASON.UNSUPPORTED_TIF, cloidRaw);
    }

    const quantity = this.toSafeInteger(sizeRaw);
    const price = this.toSafeInteger(limitPxRaw);

    if (quantity === null || price === null || quantity <= 0 || price <= 0) {
      return this.markProcessed(action, STATUS.REJECTED, REASON.INVALID_ACTION, cloidRaw);
    }

    const orderId = cloidRaw.toString();
    const submitResult = await this.engine.submitOrder({
      id: orderId,
      symbol,
      userId: action.sender.toLowerCase(),
      side: isBuy ? 'buy' : 'sell',
      kind: 'limit',
      quantity,
      price,
      timeInForce: tif,
    });

    const fills = submitResult.trades.filter(
      (trade) => trade.takerOrderId === orderId || trade.makerOrderId === orderId
    );

    const filledQuantity = fills.reduce((sum, trade) => sum + trade.quantity, 0);
    const weightedNotional = fills.reduce((sum, trade) => sum + trade.quantity * trade.price, 0);
    const executionPrice = filledQuantity > 0 ? Math.round(weightedNotional / filledQuantity) : 0;

    const outcome = this.mapLimitOrderOutcome(submitResult.order.status, this.extractOrderReason(submitResult), filledQuantity);
    const status = outcome.status;
    const reason = outcome.reason;

    if (filledQuantity === 0 || executionPrice === 0) {
      return this.markProcessed(action, status, reason, cloidRaw);
    }

    return this.sendTransaction(
      this.config.hyperCoreAddress,
      encodeFunctionData({
        abi: hyperCoreAbi,
        functionName: 'applyPerpBridgeActionResult',
        args: [
          action.actionId,
          action.sender,
          perpAsset,
          isBuy,
          BigInt(Math.round(filledQuantity)),
          BigInt(executionPrice),
          cloidRaw,
          status,
          reason,
          action.l1Block,
        ],
      })
    );
  }

  private async processCancelByOidAction(action: QueuedAction): Promise<boolean> {
    let orderIdRaw = 0n;
    let asset = 0;

    try {
      const [assetRaw, decodedOrderId] = decodeAbiParameters(
        [{ type: 'uint32' }, { type: 'uint64' }],
        action.payload
      );

      asset = Number(assetRaw);
      orderIdRaw = decodedOrderId;
    } catch (error) {
      logger.warn('failed to decode cancel-by-oid payload', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.DECODE_FAILED, 0n);
    }

    try {
      const symbol = this.resolveSymbolForAsset(asset);
      if (!symbol) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.SYMBOL_NOT_MAPPED, 0n);
      }

      const cancelResult = await this.engine.cancelOrder(orderIdRaw.toString(), action.sender.toLowerCase(), symbol);

      const status = cancelResult.canceled ? STATUS.CANCELED : STATUS.REJECTED;
      const reason = cancelResult.canceled ? REASON.NONE : REASON.ORDER_NOT_FOUND;

      return this.markProcessed(action, status, reason, 0n);
    } catch (error) {
      logger.warn('failed to process cancel-by-oid action', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.ENGINE_ERROR, 0n);
    }
  }

  private async processCancelByCloidAction(action: QueuedAction): Promise<boolean> {
    let cloidRaw = 0n;
    let asset = 0;

    try {
      const [assetRaw, decodedCloid] = decodeAbiParameters(
        [{ type: 'uint32' }, { type: 'uint128' }],
        action.payload
      );

      asset = Number(assetRaw);
      cloidRaw = decodedCloid;
    } catch (error) {
      logger.warn('failed to decode cancel action payload', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.DECODE_FAILED, 0n);
    }

    try {
      const symbol = this.resolveSymbolForAsset(asset);
      if (!symbol) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.SYMBOL_NOT_MAPPED, cloidRaw);
      }

      const cancelResult = await this.engine.cancelOrder(
        cloidRaw.toString(),
        action.sender.toLowerCase(),
        symbol
      );

      const status = cancelResult.canceled ? STATUS.CANCELED : STATUS.REJECTED;
      const reason = cancelResult.canceled ? REASON.NONE : REASON.ORDER_NOT_FOUND;

      return this.markProcessed(action, status, reason, cloidRaw);
    } catch (error) {
      logger.warn('failed to process cancel action', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.ENGINE_ERROR, cloidRaw);
    }
  }

  private resolveSymbolForAsset(asset: number): string | undefined {
    if (this.isSpotAsset(asset)) {
      const spotIndex = asset - SPOT_ASSET_OFFSET;
      return this.config.marketMap[String(spotIndex)];
    }
    const perpMarketMap = this.config.perpMarketMap ?? {};
    return perpMarketMap[String(asset)];
  }

  private async processSpotSendAction(action: QueuedAction): Promise<boolean> {
    let recipient: `0x${string}`;
    let token = 0n;
    let amount = 0n;

    try {
      const [decodedRecipient, decodedToken, decodedAmount] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint64' }, { type: 'uint64' }],
        action.payload
      );
      recipient = decodedRecipient;
      token = decodedToken;
      amount = decodedAmount;
    } catch (error) {
      logger.warn('failed to decode spot send action payload', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.DECODE_FAILED, 0n);
    }

    try {
      const senderBalance = await this.readSpotBalance(action.sender, token);
      if (senderBalance < amount) {
        return this.markProcessed(action, STATUS.REJECTED, REASON.INSUFFICIENT_BALANCE, 0n);
      }

      return this.sendTransaction(
        this.config.hyperCoreAddress,
        encodeFunctionData({
          abi: hyperCoreAbi,
          functionName: 'applySpotSendAction',
          args: [action.actionId, action.sender, recipient, token, amount, action.l1Block],
        })
      );
    } catch (error) {
      logger.warn('failed to process spot send action', {
        actionId: action.actionId.toString(),
        error: String(error),
      });
      return this.markProcessed(action, STATUS.ERROR, REASON.ENGINE_ERROR, 0n);
    }
  }

  private async markProcessed(
    action: QueuedAction,
    status: number,
    reason: number,
    cloid: bigint
  ): Promise<boolean> {
    return this.sendTransaction(
      this.config.hyperCoreAddress,
      encodeFunctionData({
        abi: hyperCoreAbi,
        functionName: 'markBridgeActionProcessed',
        args: [action.actionId, status, reason, action.l1Block, cloid],
      })
    );
  }

  private async getSpotTokens(spotIndex: number): Promise<{ baseToken: bigint; quoteToken: bigint } | null> {
    const cached = this.spotTokenCache.get(spotIndex);
    if (cached) {
      return cached;
    }

    const spotInfo = await this.bridge.publicClient.readContract({
      address: this.config.hyperCoreAddress,
      abi: hyperCoreAbi,
      functionName: 'getSpotInfo',
      args: [spotIndex],
    });

    const tokens = this.extractSpotTokens(spotInfo);
    if (!tokens) {
      return null;
    }

    this.spotTokenCache.set(spotIndex, tokens);
    return tokens;
  }

  private extractSpotTokens(spotInfo: unknown): { baseToken: bigint; quoteToken: bigint } | null {
    if (Array.isArray(spotInfo) && Array.isArray(spotInfo[1])) {
      const tokenArray = spotInfo[1] as unknown[];
      if (tokenArray.length === 2) {
        return {
          baseToken: BigInt(tokenArray[0] as bigint),
          quoteToken: BigInt(tokenArray[1] as bigint),
        };
      }
    }

    if (spotInfo && typeof spotInfo === 'object') {
      const value = spotInfo as { tokens?: unknown };
      if (Array.isArray(value.tokens) && value.tokens.length === 2) {
        return {
          baseToken: BigInt(value.tokens[0] as bigint),
          quoteToken: BigInt(value.tokens[1] as bigint),
        };
      }
    }

    return null;
  }

  private async hasSufficientLimitOrderBalance(
    sender: `0x${string}`,
    isBuy: boolean,
    sizeRaw: bigint,
    limitPxRaw: bigint,
    spotTokens: { baseToken: bigint; quoteToken: bigint }
  ): Promise<boolean> {
    if (isBuy) {
      const requiredQuote = (sizeRaw * limitPxRaw) / 100_000_000n;
      const quoteBalance = await this.readSpotBalance(sender, spotTokens.quoteToken);
      return quoteBalance >= requiredQuote;
    }

    const baseBalance = await this.readSpotBalance(sender, spotTokens.baseToken);
    return baseBalance >= sizeRaw;
  }

  private async readSpotBalance(user: `0x${string}`, token: bigint): Promise<bigint> {
    return this.bridge.publicClient.readContract({
      address: this.config.hyperCoreAddress,
      abi: hyperCoreAbi,
      functionName: 'spotBalances',
      args: [user, token],
    });
  }

  private mapLimitOrderOutcome(
    orderStatus: string,
    orderReason: string | undefined,
    filledQuantity: number
  ): { status: number; reason: number } {
    if (orderStatus === 'FILLED') {
      return { status: STATUS.FILLED, reason: REASON.NONE };
    }

    if (orderStatus === 'PARTIALLY_FILLED') {
      return { status: STATUS.PARTIAL_FILLED, reason: REASON.NONE };
    }

    if (orderStatus === 'NEW') {
      return { status: STATUS.OPEN, reason: REASON.NONE };
    }

    if (orderStatus === 'CANCELED') {
      return { status: STATUS.CANCELED, reason: REASON.NONE };
    }

    if (orderStatus === 'EXPIRED') {
      if (filledQuantity > 0) {
        return { status: STATUS.PARTIAL_FILLED, reason: REASON.NONE };
      }
      return { status: STATUS.CANCELED, reason: REASON.NONE };
    }

    if (orderStatus === 'REJECTED') {
      return { status: STATUS.REJECTED, reason: this.mapOrderRejectionReason(orderReason) };
    }

    return { status: STATUS.ERROR, reason: REASON.ENGINE_ERROR };
  }

  private mapOrderRejectionReason(orderReason: string | undefined): number {
    if (!orderReason) {
      return REASON.ENGINE_ERROR;
    }

    if (orderReason === 'symbol_mismatch') {
      return REASON.SYMBOL_NOT_MAPPED;
    }

    if (orderReason === 'order_not_found' || orderReason === 'user_mismatch') {
      return REASON.ORDER_NOT_FOUND;
    }

    if (
      orderReason === 'missing_user_id' ||
      orderReason === 'invalid_quantity' ||
      orderReason === 'quantity_not_lot_multiple' ||
      orderReason === 'quantity_below_minimum' ||
      orderReason === 'invalid_limit_price' ||
      orderReason === 'price_not_tick_multiple' ||
      orderReason === 'market_order_cannot_have_price' ||
      orderReason === 'invalid_min_quantity' ||
      orderReason === 'min_quantity_not_lot_multiple' ||
      orderReason === 'iceberg_requires_limit_order' ||
      orderReason === 'invalid_iceberg_display_quantity'
    ) {
      return REASON.INVALID_ACTION;
    }

    return REASON.ENGINE_ERROR;
  }

  private extractOrderReason(submitResult: {
    order: { id: string };
    events: Array<{ orderId: string; reason?: string }>;
  }): string | undefined {
    for (let i = submitResult.events.length - 1; i >= 0; i -= 1) {
      const event = submitResult.events[i];
      if (event.orderId === submitResult.order.id && event.reason) {
        return event.reason;
      }
    }

    return undefined;
  }

  private mapTimeInForce(encodedTif: number): 'GTC' | 'IOC' | null {
    if (encodedTif === 2) {
      return 'GTC';
    }
    if (encodedTif === 3) {
      return 'IOC';
    }
    return null;
  }

  private toSafeInteger(value: bigint): number | null {
    if (value < 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }

    return Number(value);
  }

  private async sendTransaction(to: `0x${string}`, data: `0x${string}`): Promise<boolean> {
    const walletClient = this.bridge.walletClient;
    if (!walletClient || !walletClient.account) {
      logger.warn('bridge wallet is not configured');
      return false;
    }

    try {
      const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        chain: this.bridge.publicClient.chain,
        to,
        data,
        value: 0n,
      });

      const receipt = await this.bridge.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        logger.warn('bridge transaction reverted', {
          to,
          hash,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.warn('bridge transaction failed', {
        to,
        error: String(error),
      });
      return false;
    }
  }
}
