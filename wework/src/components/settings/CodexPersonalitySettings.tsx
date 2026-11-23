import {
  DEFAULT_CODEX_PERSONALITY,
  getLocalCodexPersonality,
  saveLocalCodexPersonality,
  type CodexPersonality,
} from '@/features/model-settings/localCodexSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { useDocumentEvent } from '@wegent/collaboration/dom-events'
import { Button } from '@wegent/collaboration/markdown/Button'
import { useRef, useState, useSyncExternalStore } from 'react'
import { SettingsGroup, SettingsRow } from './settings-ui'

const PERSONALITIES: CodexPersonality[] = ['friendly', 'pragmatic']
export function CodexPersonalitySettings() {
  const { t } = useTranslation('common')
  const [resource] = useState(() =>
    createAsyncResource('codex/personality', getLocalCodexPersonality, {
      failure: error => console.error('[Wework] Failed to read Codex personality', error),
    })
  )
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const [selection, setSelection] = useState<CodexPersonality | null>(null)
  const personality = selection ?? snapshot.data ?? DEFAULT_CODEX_PERSONALITY
  const loading = !snapshot.settled
  const [saving, setSaving] = useState(false)
  const [writeError, setError] = useState<string | null>(null)
  const error = writeError ?? (snapshot.error ? t('workbench.codex_personality_read_failed') : null)
  const pending = useRef(false)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useDocumentEvent(
    'mousedown',
    event => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    },
    { enabled: open }
  )

  const selectPersonality = async (nextPersonality: CodexPersonality) => {
    if (pending.current) return
    pending.current = true
    setSelection(nextPersonality)
    setOpen(false)
    setSaving(true)
    setError(null)
    try {
      const receipt = await saveLocalCodexPersonality(nextPersonality)
      resource.update(() => receipt)
    } catch (error) {
      console.error('[Wework] Failed to write Codex personality', error)
      setError(t('workbench.codex_personality_save_failed'))
    } finally {
      pending.current = false
      setSelection(null)
      setSaving(false)
    }
  }
  return (
    <SettingsGroup className="mt-4">
      <SettingsRow
        label={t('workbench.codex_personality_title')}
        description={t('workbench.codex_personality_description')}
        error={error ?? undefined}
      >
        <SelectField<CodexPersonality>
          value={personality}
          onChange={next => void selectPersonality(next)}
          disabled={loading || saving}
          testId="codex-personality-select"
          accessibleLabel={t('workbench.codex_personality_title')}
          options={PERSONALITIES.map(value => ({
            value,
            label: t(`workbench.codex_personality_${value}`),
            description: t(`workbench.codex_personality_${value}_description`),
            testId: `codex-personality-option-${value}`,
          }))}
        />
        {error && (
          <Button
            variant="ghost"
            disabled={loading || saving}
            data-testid="codex-personality-retry"
            onClick={() => {
              setError(null)
              void resource.reload()
            }}
          >
            {t('workbench.retry')}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
