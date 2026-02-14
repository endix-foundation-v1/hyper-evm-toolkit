import { buildId } from '../utils/id.js';
import { XorShift32 } from '../utils/prng.js';
import type { MempoolConfig } from '../types/config.js';
import { Logger } from '../logging/logger.js';
import type { AnvilBridge } from './anvil-bridge.js';

const logger = new Logger('virtual-mempool');

type TransactionStatus = 'pending' | 'included' | 'confirmed' | 'failed';

export interface VirtualMempoolSubmitOptions {
  gasPrice: bigint;
  maxPriorityFeePerGas: bigint;
  confirmations?: number;
}

export interface VirtualTransactionSnapshot<TResult> {
  txId: string;
  status: TransactionStatus;
  submittedAtMs: number;
  includedBlockNumber?: number;
  confirmedBlockNumber?: number;
  gasPrice: string;
  maxPriorityFeePerGas: string;
  requiredConfirmations: number;
  result?: TResult;
  error?: string;
  anvilTxHash?: `0x${string}`;
}

export interface VirtualTransactionHandle<TResult> {
  txId: string;
  confirmed: Promise<VirtualTransactionSnapshot<TResult>>;
}

interface VirtualTransaction<TResult, TPayload> {
  txId: string;
  status: TransactionStatus;
  payload: TPayload;
  submittedAtMs: number;
  includedBlockNumber?: number;
  confirmedBlockNumber?: number;
  gasPrice: bigint;
  maxPriorityFeePerGas: bigint;
  requiredConfirmations: number;
  result?: TResult;
  error?: string;
  anvilTxHash?: `0x${string}`;
  resolve: (value: VirtualTransactionSnapshot<TResult>) => void;
  reject: (reason?: unknown) => void;
}

export class VirtualMempool<TPayload, TResult> {
  private readonly random: XorShift32;
  private readonly transactions = new Map<string, VirtualTransaction<TResult, TPayload>>();
  private readonly pendingTxIds: string[] = [];

  private blockNumber = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private processingTick = false;

  constructor(
    private readonly config: MempoolConfig,
    private readonly executor: (payload: TPayload) => Promise<TResult> | TResult,
    private readonly bridge: AnvilBridge | undefined,
    private readonly onPendingCountChange?: (pendingCount: number) => void,
    seed = 7,
    private readonly onTransactionUpdate?: (
      snapshot: VirtualTransactionSnapshot<TResult>
    ) => void
  ) {
    this.random = new XorShift32(seed);
  }

  start(): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.config.blockIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  submit(payload: TPayload, options: VirtualMempoolSubmitOptions): VirtualTransactionHandle<TResult> {
    const txId = buildId('vmempool');

    let resolvePromise: (value: VirtualTransactionSnapshot<TResult>) => void;
    let rejectPromise: (reason?: unknown) => void;

    const confirmed = new Promise<VirtualTransactionSnapshot<TResult>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const tx: VirtualTransaction<TResult, TPayload> = {
      txId,
      status: 'pending',
      payload,
      submittedAtMs: Date.now(),
      gasPrice: options.gasPrice,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      requiredConfirmations: options.confirmations ?? this.config.defaultConfirmations,
      resolve: resolvePromise!,
      reject: rejectPromise!,
    };

    this.transactions.set(txId, tx);
    this.pendingTxIds.push(txId);
    this.emitTransactionUpdate(tx);
    this.notifyPendingCount();

    return { txId, confirmed };
  }

  getTransaction(txId: string): VirtualTransactionSnapshot<TResult> | undefined {
    const tx = this.transactions.get(txId);
    if (!tx) {
      return undefined;
    }

    return this.toSnapshot(tx);
  }

  listTransactions(limit = 100): VirtualTransactionSnapshot<TResult>[] {
    return Array.from(this.transactions.values())
      .sort((a, b) => b.submittedAtMs - a.submittedAtMs)
      .slice(0, limit)
      .map((tx) => this.toSnapshot(tx));
  }

  getPendingCount(): number {
    return this.pendingTxIds.length;
  }

  private async tick(): Promise<void> {
    if (this.processingTick) {
      return;
    }

    this.processingTick = true;

    try {
      this.blockNumber += 1;

      if (this.bridge) {
        await this.bridge.mineBlock();
      }

      await this.includePendingTransactions();
      this.confirmIncludedTransactions();
    } catch (error) {
      logger.error('mempool tick failed', {
        error: String(error),
      });
    } finally {
      this.processingTick = false;
    }
  }

  private async includePendingTransactions(): Promise<void> {
    if (this.pendingTxIds.length === 0) {
      return;
    }

    this.pendingTxIds.sort((leftId, rightId) => {
      const left = this.transactions.get(leftId);
      const right = this.transactions.get(rightId);
      if (!left || !right) {
        return 0;
      }

      const leftScore = left.gasPrice + left.maxPriorityFeePerGas;
      const rightScore = right.gasPrice + right.maxPriorityFeePerGas;
      if (leftScore === rightScore) {
        return left.submittedAtMs - right.submittedAtMs;
      }

      return rightScore > leftScore ? 1 : -1;
    });

    const includeCount = Math.min(this.pendingTxIds.length, this.config.maxTransactionsPerBlock);
    const txIdsToInclude = this.pendingTxIds.splice(0, includeCount);

    for (const txId of txIdsToInclude) {
      const tx = this.transactions.get(txId);
      if (!tx || tx.status !== 'pending') {
        continue;
      }

      tx.status = 'included';
      tx.includedBlockNumber = this.blockNumber;
      this.emitTransactionUpdate(tx);

      if (this.bridge) {
        tx.anvilTxHash = await this.bridge.submitNoopTransaction(tx.gasPrice, tx.maxPriorityFeePerGas);
      }

      try {
        tx.result = await this.executor(tx.payload);
      } catch (error) {
        tx.status = 'failed';
        tx.error = String(error);
        const snapshot = this.toSnapshot(tx);
        this.emitTransactionUpdate(tx);
        tx.reject(new Error(snapshot.error));
      }
    }

    this.notifyPendingCount();
  }

  private confirmIncludedTransactions(): void {
    for (const tx of this.transactions.values()) {
      if (tx.status !== 'included' || tx.includedBlockNumber === undefined) {
        continue;
      }

      const elapsedBlocks = this.blockNumber - tx.includedBlockNumber + 1;
      if (elapsedBlocks < tx.requiredConfirmations) {
        continue;
      }

      const shouldConfirm =
        this.random.nextFloat() <= this.config.confirmationProbabilityPerBlock ||
        elapsedBlocks >= tx.requiredConfirmations + 5;

      if (!shouldConfirm) {
        continue;
      }

      tx.status = 'confirmed';
      tx.confirmedBlockNumber = this.blockNumber;
      const snapshot = this.toSnapshot(tx);
      this.emitTransactionUpdate(tx);
      tx.resolve(snapshot);
    }
  }

  private toSnapshot(tx: VirtualTransaction<TResult, TPayload>): VirtualTransactionSnapshot<TResult> {
    return {
      txId: tx.txId,
      status: tx.status,
      submittedAtMs: tx.submittedAtMs,
      includedBlockNumber: tx.includedBlockNumber,
      confirmedBlockNumber: tx.confirmedBlockNumber,
      gasPrice: tx.gasPrice.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
      requiredConfirmations: tx.requiredConfirmations,
      result: tx.result,
      error: tx.error,
      anvilTxHash: tx.anvilTxHash,
    };
  }

  private notifyPendingCount(): void {
    if (this.onPendingCountChange) {
      this.onPendingCountChange(this.pendingTxIds.length);
    }
  }

  private emitTransactionUpdate(tx: VirtualTransaction<TResult, TPayload>): void {
    if (this.onTransactionUpdate) {
      this.onTransactionUpdate(this.toSnapshot(tx));
    }
  }
}
