const operations = new Map<string, Promise<void>>()

export function isHarnessAppRuntimeOperationPending(installationId: string): boolean {
  return operations.has(installationId)
}

/**
 * Launch, token handoff and stop are one installation-owned lifecycle.
 * A close must finish releasing the old routes before a reopen can store new ones.
 */
export function runHarnessAppRuntimeOperation<Result>(
  installationId: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const previous = operations.get(installationId) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  operations.set(installationId, settled)
  void settled.then(() => {
    if (operations.get(installationId) === settled) operations.delete(installationId)
  })
  return result
}
