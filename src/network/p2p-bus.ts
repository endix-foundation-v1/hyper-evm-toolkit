import { NetworkSimulator, type NetworkSimulationResult } from './network-simulator.js';

type Handler = (payload: unknown) => Promise<unknown> | unknown;

export class MockP2PBus {
  private readonly handlers = new Map<string, Handler>();

  constructor(private readonly networkSimulator: NetworkSimulator) {}

  registerHandler<TRequest, TResponse>(topic: string, handler: (payload: TRequest) => Promise<TResponse> | TResponse): void {
    this.handlers.set(topic, handler as Handler);
  }

  async request<TRequest, TResponse>(
    topic: string,
    payload: TRequest
  ): Promise<NetworkSimulationResult<TResponse>> {
    const handler = this.handlers.get(topic);
    if (!handler) {
      throw new Error(`No handler registered for topic: ${topic}`);
    }

    return this.networkSimulator.execute(async () => {
      const result = await handler(payload);
      return result as TResponse;
    });
  }
}
