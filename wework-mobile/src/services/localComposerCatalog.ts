import type { RuntimeComposerApp } from '@/types/runtime'
import { createRuntimeComposerPluginSource } from '../../../packages/chat-core/src/runtime-composer-plugin-source'
import {
  decodeRuntimeComposerSnapshot,
  type RuntimeComposerCatalogTarget,
} from '../../../packages/chat-core/src/runtime-composer-snapshot'
import { isComposerAppSelectable } from '../../../packages/chat-core/src/composer-plugin-metadata'
import {
  appReference,
  dedupeLocalSkills,
  skillReference,
} from '../../../packages/chat-core/src/runtime-composer-references'
import type { LocalRuntime } from './localRuntime'

/** Use the same addressed inventory, project visibility and references as PC Wework. */
export async function loadLocalComposerApps(options: {
  runtime: Pick<LocalRuntime, 'request' | 'ownsDevice'>
  target: RuntimeComposerCatalogTarget
  translate: (key: string) => string
  resolveAsset: (path: string) => Promise<string>
}): Promise<RuntimeComposerApp[]> {
  const { runtime, target, translate, resolveAsset } = options
  if (!runtime.ownsDevice(target.deviceId)) {
    throw new Error('插件目录不属于当前手机执行环境')
  }
  const source = createRuntimeComposerPluginSource(
    async (address, forceRefresh) => {
      const response = await runtime.request('runtime.composer.catalog.read', {
        ...('scope' in address
          ? { scope: address.scope, workspacePath: address.workspacePath }
          : { taskId: address.taskId }),
        forceRefresh,
      })
      return decodeRuntimeComposerSnapshot(address, response)
    },
    target,
    translate,
    resolveAsset
  )
  const [apps, skills] = await Promise.all([source.listApps(), source.listSkills()])
  return [
    ...apps.filter(isComposerAppSelectable).map(app => ({
      id: app.id,
      name: app.name,
      description: app.description,
      logoUrl: app.logoUrl,
      reference: appReference(app),
    })),
    ...dedupeLocalSkills(skills).map(skill => ({
      id: `skill:${skill.path}`,
      name: skill.name,
      description: skill.short_description || skill.description,
      reference: skillReference(skill),
    })),
  ]
}
