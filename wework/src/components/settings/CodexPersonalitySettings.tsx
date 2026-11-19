import {
  DEFAULT_CODEX_PERSONALITY,
  getLocalCodexPersonality,
  saveLocalCodexPersonality,
  type CodexPersonality,
} from '@/features/model-settings/localCodexSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Button } from '@wegent/collaboration/markdown/Button'
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow } from './settings-ui'

const PERSONALITIES: CodexPersonality[] = ['friendly', 'pragmatic']
export function CodexPersonalitySettings() {
  const { t } = useTranslation('common')
  const [personality, setPersonality] = useState<CodexPersonality>(DEFAULT_CODEX_PERSONALITY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void getLocalCodexPersonality()
      .then(value => {
        if (active) setPersonality(value)
      })
      .catch(cause => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : t('workbench.codex_personality_read_failed')
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [revision, t])
  const selectPersonality = async (next: CodexPersonality) => {
    const previous = personality
    setPersonality(next)
    setSaving(true)
    setError(null)
    try {
      setPersonality(await saveLocalCodexPersonality(next))
    } catch (cause) {
      setPersonality(previous)
      setError(
        cause instanceof Error ? cause.message : t('workbench.codex_personality_save_failed')
      )
    } finally {
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
              setLoading(true)
              setError(null)
              setRevision(value => value + 1)
            }}
          >
            {t('workbench.retry')}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
