import { describe, expect, it } from 'vitest';

import { loadAppConfig } from '../config/app-config.js';

function restoreEnv(name: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previousValue;
}

describe('loadAppConfig', () => {
  it('loads defaults and parses symbol list', () => {
    const previousSymbols = process.env.SYMBOLS;
    process.env.SYMBOLS = 'ETH-USD, BTC-USD';

    const config = loadAppConfig();
    expect(config.engine.symbols).toEqual(['ETH-USD', 'BTC-USD']);
    expect(config.port).toBeGreaterThan(0);

    restoreEnv('SYMBOLS', previousSymbols);
  });

  it('throws on invalid numeric env values', () => {
    const previousPort = process.env.PORT;
    process.env.PORT = 'not-a-number';

    expect(() => loadAppConfig()).toThrow('Invalid numeric value for PORT');

    restoreEnv('PORT', previousPort);
  });

  it('treats empty optional values as undefined', () => {
    const previousPrivateKey = process.env.ANVIL_PRIVATE_KEY;
    const previousSinkAddress = process.env.ANVIL_SINK_ADDRESS;

    process.env.ANVIL_PRIVATE_KEY = '';
    process.env.ANVIL_SINK_ADDRESS = '';

    const config = loadAppConfig();
    expect(config.bridge.privateKey).toBeUndefined();
    expect(config.bridge.sinkAddress).toBeUndefined();

    restoreEnv('ANVIL_PRIVATE_KEY', previousPrivateKey);
    restoreEnv('ANVIL_SINK_ADDRESS', previousSinkAddress);
  });

  it('parses optional core-writer bridge config', () => {
    const previousEnabled = process.env.CORE_WRITER_BRIDGE_ENABLED;
    const previousMode = process.env.CORE_WRITER_BRIDGE_MODE;
    const previousMap = process.env.CORE_WRITER_BRIDGE_MARKET_MAP;

    process.env.CORE_WRITER_BRIDGE_ENABLED = 'true';
    process.env.CORE_WRITER_BRIDGE_MODE = 'interval';
    process.env.CORE_WRITER_BRIDGE_MARKET_MAP = '1:ETH-USD,2:BTC-USD';

    const config = loadAppConfig();
    expect(config.coreWriterActionBridge?.enabled).toBe(true);
    expect(config.coreWriterActionBridge?.mode).toBe('interval');
    expect(config.coreWriterActionBridge?.marketMap).toEqual({
      '1': 'ETH-USD',
      '2': 'BTC-USD',
    });

    restoreEnv('CORE_WRITER_BRIDGE_ENABLED', previousEnabled);
    restoreEnv('CORE_WRITER_BRIDGE_MODE', previousMode);
    restoreEnv('CORE_WRITER_BRIDGE_MARKET_MAP', previousMap);
  });
});
