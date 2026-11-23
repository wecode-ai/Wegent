import { useMemo, useSyncExternalStore } from 'react'
import type { TFunction } from 'i18next'
import type { LocalHarnessPreference } from '@/lib/local-harness'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import { localPathExists } from '@/lib/local-terminal'

interface HarnessResumeInput {
  ownerKey: string
  session: LocalHarnessWorkbenchSession | null
  preference: LocalHarnessPreference | null
  model: LocalHarnessModelOption | null
  modelKey: string | null
  modelsReady: boolean
  t: TFunction<'common'>
  launch(input: {
    preference: LocalHarnessPreference
    model: LocalHarnessModelOption | null
    prompt: string
    isPrimary: boolean
    projectId: number | null
    cwd: string
    resumeSession: LocalHarnessWorkbenchSession
  }): Promise<LocalHarnessWorkbenchSession | null>
}
interface ResumeSnapshot {
  sessionId: string | null
  error: string | null
  pending: boolean
}
/** One exact persisted session owns its workspace check and launch claim across catalog refreshes. */
function createLocalHarnessResumeSource() {
  let snapshot: ResumeSnapshot = { sessionId: null, error: null, pending: false }
  let input: HarnessResumeInput | null = null
  let scope: string | null = null
  let revision = 0
  let attempted = false
  let completed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  const publish = (next: ResumeSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  function reconcile(next: HarnessResumeInput) {
    input = next
    const session = next.session
    const key = session
      ? JSON.stringify([
          next.ownerKey,
          session.sessionId,
          session.cwd,
          session.harnessId,
          session.modelKey,
          session.projectId,
          session.isPrimary,
          session.active,
        ])
      : null
    if (scope !== key) {
      revision += 1
      if (timer !== null) clearTimeout(timer)
      timer = null
      attempted = false
      completed = false
      scope = key
      publish({ sessionId: session?.sessionId ?? null, error: null, pending: false })
    }
    if (
      !session ||
      session.active ||
      attempted ||
      !next.preference ||
      (next.modelKey && (!next.modelsReady || !next.model))
    )
      return
    attempted = true
    const current = revision
    timer = setTimeout(() => {
      timer = null
      publish({ sessionId: session.sessionId, error: null, pending: true })
      void localPathExists(session.cwd)
        .then(async exists => {
          if (
            current !== revision ||
            !listeners.size ||
            !input ||
            input.session?.sessionId !== session.sessionId
          )
            return
          completed = true
          if (!exists) {
            publish({
              sessionId: session.sessionId,
              pending: false,
              error: input.t('workbench.harness_resume_workspace_missing', {
                path: session.cwd,
                defaultValue: `原工作区不存在，无法恢复会话：${session.cwd}`,
              }),
            })
            return
          }
          if (!input.preference || (input.modelKey && (!input.modelsReady || !input.model))) {
            attempted = false
            publish({ sessionId: session.sessionId, pending: false, error: null })
            return
          }
          await input.launch({
            preference: input.preference,
            model: input.model,
            prompt: '',
            isPrimary: session.isPrimary,
            projectId: session.projectId,
            cwd: session.cwd,
            resumeSession: session,
          })
          if (current === revision && listeners.size)
            publish({ sessionId: session.sessionId, pending: false, error: null })
        })
        .catch(error => {
          if (current !== revision || !listeners.size) return
          completed = true
          publish({
            sessionId: session.sessionId,
            pending: false,
            error:
              error instanceof Error
                ? error.message
                : (input?.t('workbench.harness_start_failed', '启动编码工具失败') ??
                  next.t('workbench.harness_start_failed', '启动编码工具失败')),
          })
        })
    }, 0)
  }
  return {
    getSnapshot: () => snapshot,
    observe(next: HarnessResumeInput) {
      return {
        subscribe(listener: () => void) {
          listeners.add(listener)
          reconcile(next)
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (listeners.size) return
              revision += 1
              if (timer !== null) clearTimeout(timer)
              timer = null
              if (!completed) attempted = false
            })
          }
        },
      }
    },
  }
}
export function useLocalHarnessResume(input: HarnessResumeInput) {
  const source = useMemo(() => createLocalHarnessResumeSource(), [])
  const observation = source.observe(input)
  const snapshot = useSyncExternalStore(
    observation.subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
  return snapshot.error && snapshot.sessionId
    ? { sessionId: snapshot.sessionId, message: snapshot.error }
    : null
}
