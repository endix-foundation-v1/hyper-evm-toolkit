import { rm } from 'node:fs/promises';

import { decodeFunctionData, encodeAbiParameters } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { CoreWriterActionBridge } from '../bridge/corewriter-action-bridge.js';
import type { AnvilBridge } from '../bridge/anvil-bridge.js';
import { MatchingEngine } from '../engine/matching-engine.js';
import { CommandLog } from '../logging/command-log.js';
import { MetricsRegistry } from '../metrics/registry.js';

const TEST_LOG_PATH = './data/test-corewriter-bridge-command-log.jsonl';
const CORE_WRITER_ADDRESS = '0x3333333333333333333333333333333333333333';
const HYPER_CORE_ADDRESS = '0x9999999999999999999999999999999999999999';

const HYPER_CORE_WRITE_ABI = [
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
] as const;

const HYPER_CORE_PERP_ABI = [
  ...HYPER_CORE_WRITE_ABI,
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
] as const;

function createEngine(symbols = ['ETH-USD']): MatchingEngine {
  return new MatchingEngine({
    config: {
      symbols,
      tickSize: 1,
      lotSize: 1,
      minOrderQuantity: 1,
      maxOrderBookDepth: 50,
    },
    commandLog: new CommandLog(TEST_LOG_PATH),
    metrics: new MetricsRegistry(),
    randomSeed: 777,
  });
}

function createBridgeStub(
  readContract: (request: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>,
  sendTransaction?: (request: { to: `0x${string}`; data: `0x${string}` }) => Promise<`0x${string}`>
): AnvilBridge {
  const waitForTransactionReceipt = vi.fn(async () => ({
    status: 'success' as const,
  }));

  const walletClient = sendTransaction
    ? {
        account: {
          address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        },
        sendTransaction,
      }
    : undefined;

  return {
    publicClient: {
      readContract,
      waitForTransactionReceipt,
    },
    walletClient,
  } as unknown as AnvilBridge;
}

describe('CoreWriterActionBridge', () => {
  it('processes queued limit/cancel/spot-send actions and consumes queue', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const makerPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [10001, false, 100n, 5n, false, 2, 111n]
    );

    const takerPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [10001, true, 100n, 2n, false, 3, 222n]
    );

    const cancelPayload = encodeAbiParameters([{ type: 'uint32' }, { type: 'uint128' }], [10001, 111n]);
    const cancelByOidPayload = encodeAbiParameters([{ type: 'uint32' }, { type: 'uint64' }], [10001, 111n]);
    const spotSendPayload = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint64' }, { type: 'uint64' }],
      ['0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', 0n, 10n]
    );

    let queueLength = 6n;
    let queuedActions: unknown[] = [
      {
        actionId: 1n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload: makerPayload,
        l1Block: 100n,
      },
      {
        actionId: 2n,
        sender: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        kind: 1,
        payload: takerPayload,
        l1Block: 100n,
      },
      {
        actionId: 3n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 10,
        payload: cancelByOidPayload,
        l1Block: 101n,
      },
      {
        actionId: 4n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 11,
        payload: cancelPayload,
        l1Block: 101n,
      },
      {
        actionId: 5n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 6,
        payload: spotSendPayload,
        l1Block: 101n,
      },
      {
        actionId: 6n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 77,
        payload: '0x',
        l1Block: 101n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      switch (request.functionName) {
        case 'getQueueLength':
          return queueLength;
        case 'getQueuedActions':
          return queuedActions;
        case 'processedActions':
          return false;
        case 'getSpotInfo':
          return {
            name: 'ETH-USD',
            tokens: [1n, 0n],
          };
        case 'spotBalances':
          return 1_000_000_000_000n;
        default:
          throw new Error(`unexpected readContract function: ${request.functionName}`);
      }
    });

    const sendTransactionImpl = async (
      request: { to: `0x${string}`; data: `0x${string}` }
    ): Promise<`0x${string}`> => {
      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
        queuedActions = [];
      }
      const txHash: `0x${string}` =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      return txHash;
    };
    const sendTransaction = vi.fn(sendTransactionImpl);

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
    });

    const first = await adapter.syncOnce();
    expect(first.processed).toBe(6);
    expect(first.applied).toBe(6);
    expect(first.failed).toBe(0);

    const callsToHyperCore = sendTransaction.mock.calls.filter(
      (call) => (call[0] as { to: string }).to === HYPER_CORE_ADDRESS
    );
    const callsToCoreWriter = sendTransaction.mock.calls.filter(
      (call) => (call[0] as { to: string }).to === CORE_WRITER_ADDRESS
    );

    expect(callsToHyperCore.length).toBeGreaterThanOrEqual(5);
    expect(callsToCoreWriter.length).toBe(1);

    const second = await adapter.syncOnce();
    expect(second.processed).toBe(0);
    expect(second.applied).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('returns failed actions when wallet is not configured', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const badPayload = '0x1234';

    const bridge = createBridgeStub(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return 1n;
      }

      if (request.functionName === 'getQueuedActions') {
        return [
          {
            actionId: 1n,
            sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            kind: 1,
            payload: badPayload,
            l1Block: 99n,
          },
        ];
      }

      if (request.functionName === 'processedActions') {
        return false;
      }

      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    const adapter = new CoreWriterActionBridge(bridge, createEngine(), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
    });

    const result = await adapter.syncOnce();
    expect(result.processed).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('maps no-fill IOC outcomes to canceled status with stable reason', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const iocPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [10001, false, 10000000000n, 100000000n, false, 3, 333n]
    );

    let queueLength = 1n;
    let queuedActions: unknown[] = [
      {
        actionId: 1n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload: iocPayload,
        l1Block: 101n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return queueLength;
      }
      if (request.functionName === 'getQueuedActions') {
        return queuedActions;
      }
      if (request.functionName === 'processedActions') {
        return false;
      }
      if (request.functionName === 'getSpotInfo') {
        return {
          name: 'ETH-USD',
          tokens: [1n, 0n],
        };
      }
      if (request.functionName === 'spotBalances') {
        return 1_000_000_000_000n;
      }

      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    const sendTransaction = vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
        queuedActions = [];
      }

      const txHash: `0x${string}` =
        '0x3333333333333333333333333333333333333333333333333333333333333333';
      return txHash;
    });

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
    });

    const result = await adapter.syncOnce();
    expect(result.processed).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);

    const hyperCoreCall = sendTransaction.mock.calls.find(
      (call) => (call[0] as { to: string }).to === HYPER_CORE_ADDRESS
    );
    expect(hyperCoreCall).toBeDefined();

    const decoded = decodeFunctionData({
      abi: HYPER_CORE_WRITE_ABI,
      data: (hyperCoreCall?.[0] as { data: `0x${string}` }).data,
    });

    expect(decoded.functionName).toBe('markBridgeActionProcessed');
    const args = decoded.args as readonly [bigint, number, number, bigint, bigint];
    expect(args[1]).toBe(4);
    expect(args[2]).toBe(0);
  });

  it('stops on first failed action and leaves remaining queue entries unconsumed', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const validPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [10001, true, 100n, 1n, false, 2, 999n]
    );

    let queueLength = 2n;
    const queuedActions = [
      {
        actionId: 1n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 77,
        payload: '0x',
        l1Block: 100n,
      },
      {
        actionId: 2n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload: validPayload,
        l1Block: 100n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return queueLength;
      }
      if (request.functionName === 'getQueuedActions') {
        return queuedActions;
      }
      if (request.functionName === 'processedActions') {
        return false;
      }
      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    let hyperCoreTxAttempts = 0;
    const sendTransaction = vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      if (request.to === HYPER_CORE_ADDRESS) {
        hyperCoreTxAttempts += 1;
        throw new Error('simulated hypercore tx failure');
      }

      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
      }

      const txHash: `0x${string}` =
        '0x2222222222222222222222222222222222222222222222222222222222222222';
      return txHash;
    });

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
    });

    const result = await adapter.syncOnce();

    expect(result.processed).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(hyperCoreTxAttempts).toBe(1);

    const consumeCalls = sendTransaction.mock.calls.filter(
      (call) => (call[0] as { to: string }).to === CORE_WRITER_ADDRESS
    );
    expect(consumeCalls.length).toBe(0);
  });

  it('settles filled perp limit orders via applyPerpBridgeActionResult', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const makerPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [150, false, 100n, 5n, false, 2, 1001n]
    );

    const takerPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [150, true, 100n, 2n, false, 3, 1002n]
    );

    let queueLength = 2n;
    let queuedActions: unknown[] = [
      {
        actionId: 1n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload: makerPayload,
        l1Block: 120n,
      },
      {
        actionId: 2n,
        sender: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        kind: 1,
        payload: takerPayload,
        l1Block: 120n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return queueLength;
      }
      if (request.functionName === 'getQueuedActions') {
        return queuedActions;
      }
      if (request.functionName === 'processedActions') {
        return false;
      }

      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    const sendTransaction = vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
        queuedActions = [];
      }

      const txHash: `0x${string}` =
        '0x4444444444444444444444444444444444444444444444444444444444444444';
      return txHash;
    });

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(['ETH-USD', 'HYPE-PERP']), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
      perpMarketMap: {
        '150': 'HYPE-PERP',
      },
    });

    const result = await adapter.syncOnce();
    expect(result.processed).toBe(2);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);

    const callsToHyperCore = sendTransaction.mock.calls.filter(
      (call) => (call[0] as { to: string }).to === HYPER_CORE_ADDRESS
    );
    expect(callsToHyperCore.length).toBeGreaterThanOrEqual(2);

    const hasPerpSettlement = callsToHyperCore.some((call) => {
      const decoded = decodeFunctionData({
        abi: HYPER_CORE_PERP_ABI,
        data: (call[0] as { data: `0x${string}` }).data,
      });
      return decoded.functionName === 'applyPerpBridgeActionResult';
    });

    expect(hasPerpSettlement).toBe(true);
  });

  it('rejects perp orders with unmapped symbols as SYMBOL_NOT_MAPPED', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const payload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [999, true, 100n, 1n, false, 2, 9001n]
    );

    let queueLength = 1n;
    let queuedActions: unknown[] = [
      {
        actionId: 1n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload,
        l1Block: 130n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return queueLength;
      }
      if (request.functionName === 'getQueuedActions') {
        return queuedActions;
      }
      if (request.functionName === 'processedActions') {
        return false;
      }

      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    const sendTransaction = vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
        queuedActions = [];
      }

      const txHash: `0x${string}` =
        '0x5555555555555555555555555555555555555555555555555555555555555555';
      return txHash;
    });

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(['ETH-USD', 'HYPE-PERP']), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
      perpMarketMap: {
        '150': 'HYPE-PERP',
      },
    });

    const result = await adapter.syncOnce();
    expect(result.processed).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);

    const hyperCoreCall = sendTransaction.mock.calls.find(
      (call) => (call[0] as { to: string }).to === HYPER_CORE_ADDRESS
    );
    expect(hyperCoreCall).toBeDefined();

    const decoded = decodeFunctionData({
      abi: HYPER_CORE_WRITE_ABI,
      data: (hyperCoreCall?.[0] as { data: `0x${string}` }).data,
    });

    expect(decoded.functionName).toBe('markBridgeActionProcessed');
    const args = decoded.args as readonly [bigint, number, number, bigint, bigint];
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(3);
  });

  it('cancels perp orders by cloid', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const openOrderPayload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [150, false, 100n, 5n, false, 2, 777n]
    );
    const cancelPayload = encodeAbiParameters([{ type: 'uint32' }, { type: 'uint128' }], [150, 777n]);

    let queueLength = 2n;
    let queuedActions: unknown[] = [
      {
        actionId: 11n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload: openOrderPayload,
        l1Block: 140n,
      },
      {
        actionId: 12n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 11,
        payload: cancelPayload,
        l1Block: 140n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return queueLength;
      }
      if (request.functionName === 'getQueuedActions') {
        return queuedActions;
      }
      if (request.functionName === 'processedActions') {
        return false;
      }

      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    const sendTransaction = vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
        queuedActions = [];
      }

      const txHash: `0x${string}` =
        '0x6666666666666666666666666666666666666666666666666666666666666666';
      return txHash;
    });

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(['ETH-USD', 'HYPE-PERP']), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
      perpMarketMap: {
        '150': 'HYPE-PERP',
      },
    });

    const result = await adapter.syncOnce();
    expect(result.processed).toBe(2);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);

    const decodedMarkCalls = sendTransaction.mock.calls
      .filter((call) => (call[0] as { to: string }).to === HYPER_CORE_ADDRESS)
      .map((call) =>
        decodeFunctionData({
          abi: HYPER_CORE_WRITE_ABI,
          data: (call[0] as { data: `0x${string}` }).data,
        })
      )
      .filter((decoded) => decoded.functionName === 'markBridgeActionProcessed');

    const cancelCall = decodedMarkCalls.find((decoded) => {
      const args = decoded.args as readonly [bigint, number, number, bigint, bigint];
      return args[0] === 12n;
    });

    expect(cancelCall).toBeDefined();
    const cancelArgs = (cancelCall?.args ?? []) as readonly [bigint, number, number, bigint, bigint];
    expect(cancelArgs[1]).toBe(4);
    expect(cancelArgs[2]).toBe(0);
  });

  it('rejects perp orders as SYMBOL_NOT_MAPPED when perpMarketMap is omitted', async () => {
    await rm(TEST_LOG_PATH, { force: true });

    const payload = encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'uint8' },
        { type: 'uint128' },
      ],
      [150, false, 100n, 1n, false, 2, 12345n]
    );

    let queueLength = 1n;
    let queuedActions: unknown[] = [
      {
        actionId: 20n,
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        kind: 1,
        payload,
        l1Block: 150n,
      },
    ];

    const readContract = vi.fn(async (request: { functionName: string; args?: readonly unknown[] }) => {
      if (request.functionName === 'getQueueLength') {
        return queueLength;
      }
      if (request.functionName === 'getQueuedActions') {
        return queuedActions;
      }
      if (request.functionName === 'processedActions') {
        return false;
      }

      throw new Error(`unexpected readContract function: ${request.functionName}`);
    });

    const sendTransaction = vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      if (request.to === CORE_WRITER_ADDRESS) {
        queueLength = 0n;
        queuedActions = [];
      }

      const txHash: `0x${string}` =
        '0x7777777777777777777777777777777777777777777777777777777777777777';
      return txHash;
    });

    const bridge = createBridgeStub(readContract, sendTransaction);
    const adapter = new CoreWriterActionBridge(bridge, createEngine(['ETH-USD', 'HYPE-PERP']), {
      enabled: true,
      mode: 'manual',
      intervalMs: 100,
      coreWriterAddress: CORE_WRITER_ADDRESS,
      hyperCoreAddress: HYPER_CORE_ADDRESS,
      marketMap: {
        '1': 'ETH-USD',
      },
    });

    const result = await adapter.syncOnce();
    expect(result.processed).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);

    const hyperCoreCall = sendTransaction.mock.calls.find(
      (call) => (call[0] as { to: string }).to === HYPER_CORE_ADDRESS
    );
    expect(hyperCoreCall).toBeDefined();

    const decoded = decodeFunctionData({
      abi: HYPER_CORE_WRITE_ABI,
      data: (hyperCoreCall?.[0] as { data: `0x${string}` }).data,
    });

    expect(decoded.functionName).toBe('markBridgeActionProcessed');
    const args = decoded.args as readonly [bigint, number, number, bigint, bigint];
    expect(args[1]).toBe(5);
    expect(args[2]).toBe(3);
  });
});
