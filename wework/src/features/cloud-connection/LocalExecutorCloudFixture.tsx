import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import type { LocalExecutorCloudInput } from './localExecutorCloudService'

/** Exercise cloud configuration through the real startup owner. */
export function LocalExecutorCloudBridge(input: LocalExecutorCloudInput) {
  return <LocalRuntimeInitializer cloudConnection={input}>{null}</LocalRuntimeInitializer>
}
