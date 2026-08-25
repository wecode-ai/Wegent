import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import { ensureBundledPluginInstalled } from '@/desktop/localExecutor'
import { queuePluginReferenceTrial } from '@/features/plugins/pluginTrial'
import type { ProjectWithTasks } from '@/types/api'

interface QueueSmartAppBuilderInput {
  displayName: string
  prompt: string
  targetProject?: ProjectWithTasks
}

export async function queueSmartAppBuilder({
  displayName,
  prompt,
  targetProject,
}: QueueSmartAppBuilderInput): Promise<void> {
  await ensureBundledPluginInstalled('smart-app-builder')
  const queued = queuePluginReferenceTrial({
    pluginName: 'smart-app-builder',
    marketplaceName: 'wework-personal',
    displayName,
    prompt,
    openInNewChat: true,
    targetProject,
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
