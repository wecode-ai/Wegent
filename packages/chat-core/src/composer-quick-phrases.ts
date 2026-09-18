export type QuickPhraseMode = 'normal' | 'plan' | 'goal'

export interface QuickPhrase {
  id: string
  title: string
  content: string
  mode: QuickPhraseMode
  attachmentPaths?: string[]
  createdAt?: number
}

export const defaultQuickPhrases: QuickPhrase[] = [
  {
    id: 'default-summary-progress',
    title: '总结当前进展',
    content: '总结目前完成的工作和下一步建议',
    mode: 'normal',
  },
  {
    id: 'default-create-plan',
    title: '制定实施计划',
    content: '分析需求并制定详细的实施计划',
    mode: 'plan',
  },
  {
    id: 'default-pursue-goal',
    title: '持续完成这个目标',
    content: '持续推进这个目标，直到真正完成',
    mode: 'goal',
  },
]

export interface QuickPhrasePreferencesPort {
  load(): Promise<QuickPhrase[]>
  save(phrases: QuickPhrase[]): Promise<QuickPhrase[]>
}

export function createQuickPhrasePreferencesStore(port: QuickPhrasePreferencesPort) {
  let snapshot: {
    phrases: QuickPhrase[]
    loaded: boolean
    pending: boolean
    error: string | null
  } = {
    phrases: [],
    loaded: false,
    pending: false,
    error: null,
  }
  let operation: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const run = (request: () => Promise<QuickPhrase[]>, rejectFailure: boolean) => {
    operation = Promise.resolve()
      .then(request)
      .then(phrases => {
        publish({ phrases, loaded: true })
      })
      .catch(cause => {
        publish({ error: cause instanceof Error ? cause.message : String(cause) })
        if (rejectFailure) throw cause
      })
      .finally(() => {
        operation = null
        publish({ pending: false })
      })
    publish({ pending: true, error: null })
    return operation
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load: () => operation ?? run(() => port.load(), false),
    save(phrases: QuickPhrase[]) {
      if (operation || !snapshot.loaded)
        return Promise.reject(new Error('Quick phrase preferences are not ready'))
      return run(() => port.save(phrases), true)
    },
  }
}
