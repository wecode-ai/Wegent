export function createRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}
