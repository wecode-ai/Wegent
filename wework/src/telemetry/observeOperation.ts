import { beginOperation, type OperationKey } from './operationBus'

/** Observe the confirmed result, preserving the original return value or error. */
export async function observeOperation<T>(
  key: OperationKey,
  execute: () => Promise<T>,
  succeeded: (result: T) => boolean = () => true
): Promise<T> {
  const attempt = beginOperation(key)
  let result: T
  try {
    result = await execute()
  } catch (error) {
    attempt.fail('request')
    throw error
  }
  if (succeeded(result)) attempt.succeed()
  else attempt.fail('confirm')
  return result
}
