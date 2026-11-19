import type { SetStateAction } from 'react'
import { appendCollaborationGroupResponsibility } from './collaborationGroupDraft'
import type {
  ProjectCreateResourceSetup,
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateCollaborationGroupDraftInput,
  ProjectCreateCollaborationGroupGenerationEvent,
  ProjectCreateGenerationProgressPhase,
} from './types'

type Generate = NonNullable<ProjectCreateResourceSetup['generateCollaborationGroupDraft']>
interface GenerationSnapshot {
  draft: ProjectCreateCollaborationGroupDraft | null
  generating: boolean
  phase: ProjectCreateGenerationProgressPhase | null
  principles: string[]
  leader: { kind: 'human' | 'agent'; id: string } | null
  revealedAgentIds: string[]
  responsibilities: Record<string, string>
  stages: Array<{ id: string; name: string }>
  startedAt: number
  error: string | null
}
const INITIAL: GenerationSnapshot = {
  draft: null,
  generating: false,
  phase: null,
  principles: [],
  leader: null,
  revealedAgentIds: [],
  responsibilities: {},
  stages: [],
  startedAt: 0,
  error: null,
}

/** One creation dialog owns its streamed generation and progressive participant presentation. */
export function createGroupGenerationSession() {
  const listeners = new Set<() => void>()
  let snapshot = INITIAL
  let revision = 0
  let startedAt = 0
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  const queued = new Set<string>()
  const revealed = new Set<string>()
  let agentQueue: string[] = []
  let presentation: { ids: string[]; resolve(ready: boolean): void } | undefined
  const publish = (patch: Partial<GenerationSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const diagnostic = (event: string, details: Record<string, unknown> = {}) =>
    console.debug('[CollaborationGroupGeneration]', {
      event,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...details,
    })
  const clearPresentation = () => {
    clearTimeout(revealTimer)
    revealTimer = undefined
    agentQueue = []
    queued.clear()
    presentation?.resolve(false)
    presentation = undefined
  }
  const cancel = () => {
    revision++
    clearPresentation()
    if (snapshot.generating || snapshot.phase) publish({ generating: false, phase: null })
  }
  const revealNext = () => {
    if (revealTimer !== undefined || !listeners.size) return
    const agentId = agentQueue.shift()
    if (!agentId) return
    revealTimer = setTimeout(
      () => {
        revealTimer = undefined
        queued.delete(agentId)
        revealed.add(agentId)
        publish({ revealedAgentIds: [...revealed] })
        diagnostic('agent-revealed', { agentId, remainingAgents: agentQueue.length })
        if (presentation?.ids.every(id => revealed.has(id))) {
          const waiting = presentation
          presentation = undefined
          waiting.resolve(true)
        }
        revealNext()
      },
      revealed.size === 0 ? 80 : 420
    )
  }
  const enqueueAgent = (agentId: string, responsibility?: string | null) => {
    if (responsibility && snapshot.responsibilities[agentId] !== responsibility)
      publish({ responsibilities: { ...snapshot.responsibilities, [agentId]: responsibility } })
    if (queued.has(agentId) || revealed.has(agentId)) return
    queued.add(agentId)
    agentQueue.push(agentId)
    diagnostic('agent-detected', { agentId, queuedAgents: agentQueue.length })
    revealNext()
  }
  const structuredEvent = (event: ProjectCreateCollaborationGroupGenerationEvent) => {
    diagnostic('structured-event', { type: event.type })
    if (event.type === 'participant_started' && event.leader)
      publish({ leader: { kind: event.kind, id: event.id } })
    if (event.type === 'participant_responsibility') {
      const key = event.kind === 'human' ? `human:${event.id}` : event.id
      publish({
        responsibilities: {
          ...snapshot.responsibilities,
          [key]: appendCollaborationGroupResponsibility(snapshot.responsibilities[key], event.text),
        },
      })
      if (event.kind === 'agent') enqueueAgent(event.id)
    }
    if (event.type === 'principle') publish({ principles: [...snapshot.principles, event.text] })
    if (event.type === 'stage') {
      const stage = { id: event.id, name: event.name }
      publish({
        stages: snapshot.stages.some(current => current.id === event.id)
          ? snapshot.stages.map(current => (current.id === event.id ? stage : current))
          : [...snapshot.stages, stage],
      })
    }
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) cancel()
      }
    },
    cancel,
    setDraft(value: SetStateAction<ProjectCreateCollaborationGroupDraft | null>) {
      publish({ draft: typeof value === 'function' ? value(snapshot.draft) : value })
    },
    setError(value: SetStateAction<string | null>) {
      publish({ error: typeof value === 'function' ? value(snapshot.error) : value })
    },
    revealAgents(ids: string[]) {
      clearPresentation()
      revealed.clear()
      ids.forEach(id => revealed.add(id))
      publish({ revealedAgentIds: [...revealed] })
    },
    async generate(
      generate: Generate,
      input: ProjectCreateCollaborationGroupDraftInput,
      formatError: (cause: unknown) => string
    ) {
      if (!listeners.size) return
      revision++
      clearPresentation()
      const version = revision
      const current = () => revision === version && listeners.size > 0
      revealed.clear()
      startedAt = performance.now()
      publish({
        ...INITIAL,
        draft: snapshot.draft,
        generating: true,
        phase: 'preparing',
        startedAt: Date.now(),
      })
      diagnostic('generation-started', {
        agentCount: input.agents.length,
        modelName: input.modelSelection.modelName,
      })
      try {
        const draft = await generate(
          input,
          phase => {
            if (!current()) return
            diagnostic('phase-changed', { phase })
            publish({ phase })
          },
          event => {
            if (current()) structuredEvent(event)
          }
        )
        if (!current()) return
        const participants = [draft.leader, ...draft.members]
        publish({
          leader: { kind: draft.leader.kind, id: draft.leader.id },
          responsibilities: Object.fromEntries(
            participants.map(participant => [
              participant.kind === 'human' ? `human:${participant.id}` : participant.id,
              participant.responsibility,
            ])
          ),
          stages: draft.stages.map(stage => ({ id: stage.id, name: stage.name })),
        })
        input.agents.forEach(agent =>
          enqueueAgent(
            agent.id,
            participants.find(
              participant => participant.kind === 'agent' && participant.id === agent.id
            )?.responsibility
          )
        )
        const ids = input.agents.map(agent => agent.id)
        if (!ids.every(id => revealed.has(id))) {
          const ready = await new Promise<boolean>(resolve => {
            presentation = { ids, resolve }
          })
          if (!ready) return
        }
        if (!current()) return
        clearPresentation()
        publish({ draft, generating: false, phase: null })
        return draft
      } catch (cause) {
        if (current()) publish({ error: formatError(cause) })
      } finally {
        if (current() && snapshot.generating) publish({ generating: false, phase: null })
      }
    },
  }
}
