import { resolve } from 'node:path'

const operations = new Map<string, Promise<void>>()

/** Serialize writers for one path without blocking unrelated installations. */
export function serializePathOperation<Result>(
  path: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const key = resolve(path)
  const result = (operations.get(key) ?? Promise.resolve()).then(operation)
  const drained = result.then(
    () => undefined,
    () => undefined
  )
  operations.set(key, drained)
  void drained.then(() => {
    if (operations.get(key) === drained) operations.delete(key)
  })
  return result
}
