let fallbackCounter = 0;

export function buildId(prefix: string): string {
  const hasRandomUuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  if (hasRandomUuid) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  fallbackCounter += 1;
  return `${prefix}_${Date.now()}_${fallbackCounter}`;
}
