import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  groupLegacyModels,
  saveProviderConfiguration,
  type ModelConfigurationSnapshot,
} from '@/features/model-settings/providerModelConfiguration'
import {
  listLocalModelConfigs,
  type LocalModelConfig,
} from '@/features/model-settings/localModelSettings'

/** Read the same native projection the model selector consumes, including explicit invalid legacy tests. */
export function readNativeModelFixtures(): LocalModelConfig[] {
  return listLocalModelConfigs()
}

/** Save isolated E2E models through their real configuration owner and await its Executor synchronization. */
export async function writeNativeModelFixtures(models: LocalModelConfig[]): Promise<void> {
  const snapshot = await invokeDesktopHost<ModelConfigurationSnapshot>('modelConfiguration.read')
  if (snapshot.error) throw new Error(snapshot.error)
  await saveProviderConfiguration(snapshot.revision, groupLegacyModels(models))
}
