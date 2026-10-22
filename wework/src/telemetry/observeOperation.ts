import { beginOperation, type OperationKey, type OperationResultDetail } from './operationBus'

/** Observe the confirmed result, preserving the original return value or error. */
export async function observeOperation<T>(
  key: OperationKey,
  execute: () => Promise<T>,
  succeeded: (result: T) => boolean = () => true,
  detail: OperationResultDetail = {}
): Promise<T> {
  const attempt = beginOperation(key, detail)
  let result: T
  try {
    result = await execute()
  } catch (error) {
    attempt.fail('request')
    throw error
  }
  try {
    if (succeeded(result)) attempt.succeed()
    else attempt.fail('confirm')
  } catch {
    // Classification is telemetry-only and must preserve the resolved business result.
    attempt.fail('confirm')
  }
  return result
}
