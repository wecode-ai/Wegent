import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type {
  ModelProvider,
  PublicModelProvider,
} from '../../../electron/src/host/model-configuration-contract'

export interface ProviderConnectionTestResult {
  model: string
  error?: string
}

/** Probe through the host so saved credentials never enter the renderer. */
export async function testProviderConnection(
  provider: ModelProvider | PublicModelProvider
): Promise<ProviderConnectionTestResult[]> {
  if (!provider.models.length) throw new Error('Select at least one model to test')
  const draft = { ...provider } as ModelProvider & { api_key_configured?: boolean }
  delete draft.api_key_configured
  delete draft.api_key_ref
  if (!draft.api_key) delete draft.api_key
  const results = await invokeDesktopHost<ProviderConnectionTestResult[]>(
    'modelConfiguration.test',
    { provider: draft }
  )
  if (results.length !== provider.models.length)
    throw new Error('The saved API Key is unavailable. Enter a replacement key.')
  return results
}
