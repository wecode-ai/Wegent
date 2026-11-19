import { updateAppPreferences } from '@/desktop/appPreferences'
import {
  formatLocalHarnessArgs,
  formatLocalHarnessEnv,
  normalizeLocalHarnessPreferences,
  parseLocalHarnessArgs,
  parseLocalHarnessEnv,
  LOCAL_HARNESS_IDS,
  type LocalHarnessId,
  type LocalHarnessPreference,
} from '@/lib/local-harness'

export interface HarnessDraft {
  preference: LocalHarnessPreference
  argsText: string
  envText: string
}
type Drafts = Record<LocalHarnessId, HarnessDraft>
type Status =
  | { kind: 'idle' | 'saving' | 'saved' | 'failed' }
  | { kind: 'invalid'; id: LocalHarnessId; line: string }
function buildDrafts(preferences: LocalHarnessPreference[]): Drafts {
  return Object.fromEntries(
    normalizeLocalHarnessPreferences(preferences).map(preference => [
      preference.id,
      {
        preference,
        argsText: formatLocalHarnessArgs(preference.args),
        envText: formatLocalHarnessEnv(preference.env),
      },
    ])
  ) as Drafts
}

/** Accepted writes finish; only active editors schedule new autosaves. */
export function createHarnessSettingsEditor(initial: LocalHarnessPreference[]) {
  const listeners = new Set<() => void>()
  let source = initial
  let state = {
    drafts: buildDrafts(initial),
    dirty: false,
    saving: false,
    status: { kind: 'idle' } as Status,
  }
  let revision = 0,
    attempted = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline = 0
  const publish = (next: Partial<typeof state>) => {
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = undefined
    if (listeners.size && state.dirty && !state.saving && revision !== attempted)
      timer = setTimeout(() => void save(), Math.max(0, deadline - Date.now()))
  }
  const save = async () => {
    if (!listeners.size || !state.dirty || state.saving) return
    clearTimeout(timer)
    timer = undefined
    const submitted = revision
    attempted = submitted
    const localHarnesses: LocalHarnessPreference[] = []
    for (const id of LOCAL_HARNESS_IDS) {
      const draft = state.drafts[id],
        parsed = parseLocalHarnessEnv(draft.envText)
      if (parsed.error) {
        publish({ status: { kind: 'invalid', id, line: parsed.error.split(':')[1] } })
        return
      }
      localHarnesses.push({
        ...draft.preference,
        executablePath: draft.preference.executablePath?.trim() || null,
        args: parseLocalHarnessArgs(draft.argsText),
        env: parsed.env,
      })
    }
    publish({ saving: true, status: { kind: 'saving' } })
    try {
      const preferences = await updateAppPreferences({ localHarnesses })
      if (revision === submitted) {
        source = preferences.localHarnesses
        publish({ drafts: buildDrafts(source), dirty: false, status: { kind: 'saved' } })
      } else publish({ status: { kind: 'idle' } })
    } catch (error) {
      console.error('Failed to save local harness settings:', error)
      publish({ status: { kind: 'failed' } })
    } finally {
      publish({ saving: false })
      schedule()
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void, preferences: LocalHarnessPreference[]) {
      listeners.add(listener)
      if (!state.dirty && source !== preferences) {
        source = preferences
        publish({ drafts: buildDrafts(source) })
      }
      schedule()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearTimeout(timer)
          timer = undefined
        }
      }
    },
    updateDraft(id: LocalHarnessId, update: (draft: HarnessDraft) => HarnessDraft) {
      if (!listeners.size) return
      revision += 1
      deadline = Date.now() + 400
      publish({
        drafts: { ...state.drafts, [id]: update(state.drafts[id]) },
        dirty: true,
        status: { kind: 'idle' },
      })
      schedule()
    },
    retry() {
      if (state.status.kind === 'failed') void save()
    },
  }
}
