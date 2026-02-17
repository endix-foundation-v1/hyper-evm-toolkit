import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { AnvilBridgeConfig } from '../types/config.js';
import { Logger } from '../logging/logger.js';

const logger = new Logger('anvil-bridge');

export class AnvilBridge {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;

  private readonly chain: Chain;

  constructor(private readonly config: AnvilBridgeConfig) {
    this.chain = {
      id: config.chainId,
      name: 'Anvil',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: {
        default: { http: [config.rpcUrl] },
      },
    };

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.rpcUrl),
    });

    if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey as `0x${string}`);
      this.walletClient = createWalletClient({
        chain: this.chain,
        transport: http(config.rpcUrl),
        account,
      });
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async mineBlock(): Promise<boolean> {
    try {
      await this.publicClient.request({ method: 'evm_mine' as never });
      return true;
    } catch (error) {
      logger.warn('evm_mine failed', {
        error: String(error),
      });
      return false;
    }
  }

  async submitNoopTransaction(gasPrice?: bigint, maxPriorityFeePerGas?: bigint): Promise<`0x${string}` | undefined> {
    if (!this.walletClient || !this.config.sinkAddress) {
      return undefined;
    }

    try {
      const account = this.walletClient.account;
      if (!account) {
        return undefined;
      }

      const hash = await this.walletClient.sendTransaction({
        account,
        chain: this.chain,
        to: this.config.sinkAddress,
        value: 0n,
        gas: 21_000n,
        maxFeePerGas: gasPrice ?? 1_000_000_000n,
        maxPriorityFeePerGas: maxPriorityFeePerGas ?? 100_000_000n,
      });

      return hash;
    } catch (error) {
      logger.warn('noop transaction failed', {
        error: String(error),
      });
      return undefined;
    }
  }
}
