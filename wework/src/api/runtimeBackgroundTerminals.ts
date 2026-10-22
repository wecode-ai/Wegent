import type { RuntimeTaskAddress } from '@/types/api'

export interface RuntimeBackgroundTerminalsApi {
  cleanRuntimeBackgroundTerminals: (
    address: RuntimeTaskAddress
  ) => Promise<{ success: boolean; error?: string }>
}
