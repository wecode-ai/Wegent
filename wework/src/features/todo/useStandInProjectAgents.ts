import { useEffect, useState } from 'react'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceProjectAgent,
} from '@wegent/collaboration'
import type { StandInProjectRef } from '@/api/personalStandIn'

export interface StandInProjectAgentChoice {
  id: string
  name: string
  project: StandInProjectRef
  projectName: string
  agent: WorkspaceProjectAgent
}

export function projectAgentChoiceValue(choice: Pick<StandInProjectAgentChoice, 'project' | 'id'>) {
  return JSON.stringify([choice.project.store, choice.project.id, choice.id])
}

export function useStandInProjectAgents(api: SharedWorkspaceApi, projects: CollaborationProject[]) {
  const [choices, setChoices] = useState<StandInProjectAgentChoice[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const projectKey = JSON.stringify(
    projects.map(project => ({
      id: project.id,
      name: project.name,
      store: project.project_store === 'local' ? 'local' : 'cloud',
    }))
  )
  useEffect(() => {
    let active = true
    const sources = JSON.parse(projectKey) as {
      id: string
      name: string
      store: 'local' | 'cloud'
    }[]
    void Promise.allSettled(
      sources.map(async project => {
        const rows = await api.agents.list(project.id, { forceRefresh: true })
        return rows
          .filter(
            agent =>
              agent.status === 'active' &&
              agent.canUse !== false &&
              ['codex', 'claude_code'].includes(String(agent.runtime))
          )
          .map(agent => ({
            id: agent.id,
            name: agent.name,
            project: { id: project.id, store: project.store },
            projectName: project.name,
            agent,
          }))
      })
    ).then(results => {
      if (!active) return
      setChoices(results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])))
      setUnavailable(results.some(result => result.status === 'rejected'))
    })
    return () => {
      active = false
    }
  }, [api, projectKey])
  return { choices, unavailable }
}
