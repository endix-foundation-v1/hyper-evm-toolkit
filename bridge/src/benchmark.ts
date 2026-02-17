import { rm } from 'node:fs/promises';

import { MatchingEngine } from './engine/matching-engine.js';
import { CommandLog } from './logging/command-log.js';
import { MetricsRegistry } from './metrics/registry.js';
import { XorShift32 } from './utils/prng.js';

const SYMBOL = 'ETH-USD';
const ITERATIONS = 25_000;

async function benchmark(): Promise<void> {
  await rm('./data/benchmark-command-log.jsonl', { force: true });

  const metrics = new MetricsRegistry();
  const engine = new MatchingEngine({
    config: {
      symbols: [SYMBOL],
      tickSize: 1,
      lotSize: 1,
      minOrderQuantity: 1,
      maxOrderBookDepth: 500,
    },
    commandLog: new CommandLog('./data/benchmark-command-log.jsonl'),
    metrics,
    randomSeed: 999,
  });

  await seedLiquidity(engine);

  const random = new XorShift32(123);
  const latencySamples: number[] = [];

  const startedAt = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) {
    const side = random.nextFloat() > 0.5 ? 'buy' : 'sell';
    const kind = random.nextFloat() > 0.1 ? 'limit' : 'market';

    const priceOffset = random.nextInt(-30, 30);
    const quantity = random.nextInt(1, 5);
    const now = performance.now();

    await engine.submitOrder({
      symbol: SYMBOL,
      userId: `bench-user-${random.nextInt(1, 1_000)}`,
      side,
      kind,
      quantity,
      price: kind === 'limit' ? 3_000 + priceOffset : undefined,
      timeInForce: kind === 'market' ? 'IOC' : 'GTC',
    });

    latencySamples.push(performance.now() - now);
  }

  const elapsedMs = performance.now() - startedAt;
  const throughput = (ITERATIONS / elapsedMs) * 1_000;
  const sorted = latencySamples.sort((left, right) => left - right);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;

  console.log(
    JSON.stringify(
      {
        benchmark: 'virtual-hypercore-clob',
        iterations: ITERATIONS,
        elapsedMs,
        throughputOrdersPerSec: Number(throughput.toFixed(2)),
        latencyMs: {
          p50: Number(p50.toFixed(3)),
          p95: Number(p95.toFixed(3)),
          p99: Number(p99.toFixed(3)),
        },
        finalStats: engine.getStats(),
      },
      null,
      2
    )
  );
}

async function seedLiquidity(engine: MatchingEngine): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    await engine.submitOrder({
      symbol: SYMBOL,
      userId: 'seed-maker-buy',
      side: 'buy',
      kind: 'limit',
      quantity: 20,
      price: 2_950 - i,
      timeInForce: 'GTC',
    });

    await engine.submitOrder({
      symbol: SYMBOL,
      userId: 'seed-maker-sell',
      side: 'sell',
      kind: 'limit',
      quantity: 20,
      price: 3_050 + i,
      timeInForce: 'GTC',
    });
  }
}

benchmark().catch((error) => {
  console.error(error);
  process.exit(1);
});
