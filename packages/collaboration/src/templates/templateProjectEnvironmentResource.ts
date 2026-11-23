import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationProject } from '../types'

/** Project routing and its catalog share one owner; rendering never writes a parent's selection. */
export function createTemplateProjectEnvironmentResource(
  host: ProjectAgentConfigurationHost,
  project: CollaborationProject
) {
  let selected: string | undefined
  const listeners = new Set<() => void>()
  const publish = (id: string | undefined) => {
    if (selected === id) return
    selected = id
    listeners.forEach(listener => listener())
  }
  const catalog = createAsyncResource(
    `${project.project_store}:${project.id}`,
    async () => {
      const items = await host.listTemplateAgentEnvironments!(
        project.id,
        project.project_store === 'local' ? 'local' : 'cloud'
      )
      return items.filter(item => item.can_use !== false && item.status === 'online')
    },
    {
      refreshOnSubscribe: true,
      success(items) {
        if (!items.some(item => item.id === selected))
          publish(items.length === 1 ? items[0].id : undefined)
      },
    }
  )
  return {
    catalog,
    getSelection: () => selected,
    subscribeSelection(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select(id: string | undefined) {
      const items = catalog.getSnapshot().data ?? []
      publish(
        items.some(item => item.id === id) ? id : items.length === 1 ? items[0].id : undefined
      )
    },
    settingsHref: () => host.templateAgentEnvironmentSettingsHref?.(project),
  }
}

export type TemplateProjectEnvironmentResource = ReturnType<
  typeof createTemplateProjectEnvironmentResource
>
