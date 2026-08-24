import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import { queuePluginReferenceTrial } from '@/features/plugins/pluginTrial'
import { ensureBundledPluginInstalled } from '@/tauri/localExecutor'

interface QueueSmartAppBuilderInput {
  displayName: string
  prompt: string
}

export async function queueSmartAppBuilder({
  displayName,
  prompt,
}: QueueSmartAppBuilderInput): Promise<void> {
  await ensureBundledPluginInstalled('smart-app-builder')
  const queued = queuePluginReferenceTrial({
    pluginName: 'smart-app-builder',
    marketplaceName: 'wework-personal',
    displayName,
    prompt,
    openInNewChat: true,
  })
  if (!queued) throw new Error('Smart App Builder reference could not be queued')
}

export function smartAppBuilderPrompt(
  installation: HarnessAppInstallation,
  directoryPrefix: string,
  intent: string,
  completion: string
): string {
  return `${directoryPrefix}${installation.packagePath}\n${intent}\n${completion}`
}
