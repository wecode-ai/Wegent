import { useEffect, useState } from 'react'
import { Check, Loader2, Save, Terminal } from 'lucide-react'
import {
  getLocalCodexInstructions,
  saveLocalCodexInstructions,
} from '@/api/local/codexInstructions'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsPage, SettingsPageHeader, SettingsSwitch } from './settings-ui'
import {
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'
import { CodexPersonalitySettings } from './CodexPersonalitySettings'

export function ContextSettingsPage() {
  const { t } = useTranslation('common')
  const [preferences, setPreferences] = useState<AppPreferences>(defaultAppPreferences)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [savedInstructions, setSavedInstructions] = useState('')
  const [instructionsLoading, setInstructionsLoading] = useState(true)
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [instructionsSaved, setInstructionsSaved] = useState(false)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)

  const instructionsDirty = instructions !== savedInstructions

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const nextPreferences = await getAppPreferences()
        if (!cancelled) {
          setPreferences(nextPreferences)
          setError(null)
        }
      } catch (fetchError) {
        console.error('[Wework] Failed to load context settings', fetchError)
        if (!cancelled) {
          setError(t('workbench.context_settings_load_failed'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }

      try {
        const nextInstructions = await getLocalCodexInstructions()
        if (!cancelled) {
          setInstructions(nextInstructions.instructions)
          setSavedInstructions(nextInstructions.instructions)
          setInstructionsError(null)
        }
      } catch (fetchError) {
        console.error('[Wework] Failed to load Wework custom instructions', fetchError)
        if (!cancelled) {
          setInstructionsError(t('workbench.context_settings_wework_instructions_load_failed'))
        }
      } finally {
        if (!cancelled) {
          setInstructionsLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [t])

  const handleTerminalContextChange = async (enabled: boolean) => {
    setPreferences(current => ({ ...current, terminalContextInjectionEnabled: enabled }))
    setSaving(true)
    setError(null)
    try {
      const nextPreferences = await updateAppPreferences({
        terminalContextInjectionEnabled: enabled,
      })
      setPreferences(nextPreferences)
    } catch (saveError) {
      console.error('[Wework] Failed to update context settings', saveError)
      setPreferences(current => ({
        ...current,
        terminalContextInjectionEnabled: !enabled,
      }))
      setError(t('workbench.context_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveInstructions = async () => {
    setInstructionsSaving(true)
    setInstructionsSaved(false)
    setInstructionsError(null)
    try {
      const response = await saveLocalCodexInstructions(instructions)
      setInstructions(response.instructions)
      setSavedInstructions(response.instructions)
      setInstructionsSaved(true)
    } catch (saveError) {
      console.error('[Wework] Failed to save Wework custom instructions', saveError)
      setInstructionsError(t('workbench.context_settings_wework_instructions_save_failed'))
    } finally {
      setInstructionsSaving(false)
    }
  }

  return (
    <SettingsPage data-testid="context-settings-page">
      <SettingsPageHeader
        title={t('workbench.context_settings_title')}
        description={t('workbench.context_settings_subtitle')}
      />

      <section className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.context_settings_terminal_title')}
          </h2>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Terminal className="h-4 w-4 text-text-secondary" />
              <span>{t('workbench.context_settings_terminal_injection')}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_terminal_injection_description')}
            </p>
          </div>
          <SettingsSwitch
            data-testid="context-terminal-injection-toggle"
            checked={preferences.terminalContextInjectionEnabled}
            disabled={loading || saving}
            onCheckedChange={checked => {
              void handleTerminalContextChange(checked)
            }}
            aria-label={t('workbench.context_settings_terminal_injection')}
          />
        </div>
      </section>

      <CodexPersonalitySettings />

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.context_settings_wework_instructions_title')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_wework_instructions_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="context-wework-instructions-save-button"
            disabled={instructionsLoading || instructionsSaving || !instructionsDirty}
            onClick={() => void handleSaveInstructions()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-text-primary px-3 text-[13px] font-medium leading-[18px] text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {instructionsSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : instructionsSaved && !instructionsDirty ? (
              <Check className="h-4 w-4" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            <span>
              {instructionsSaving
                ? t('workbench.context_settings_wework_instructions_saving')
                : instructionsSaved && !instructionsDirty
                  ? t('workbench.context_settings_wework_instructions_saved')
                  : t('workbench.context_settings_wework_instructions_save')}
            </span>
          </button>
        </div>
        <div className="px-4 py-4">
          {instructionsLoading ? (
            <div className="flex min-h-40 items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading', '加载中...')}
            </div>
          ) : (
            <textarea
              data-testid="context-wework-instructions-textarea"
              value={instructions}
              onChange={event => {
                setInstructions(event.target.value)
                setInstructionsSaved(false)
              }}
              placeholder={t('workbench.context_settings_wework_instructions_placeholder')}
              className="min-h-40 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
            />
          )}
          {instructionsError ? (
            <p
              data-testid="context-wework-instructions-error"
              className="mt-3 text-xs text-red-500"
            >
              {instructionsError}
            </p>
          ) : (
            <p className="mt-3 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_wework_instructions_hint')}
            </p>
          )}
        </div>
      </section>

      {(loading || saving || error) && (
        <div
          data-testid="context-settings-status"
          className="mt-4 flex items-center gap-2 text-xs text-text-secondary"
        >
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            {error ??
              (loading ? t('common.loading', '加载中...') : t('workbench.context_settings_saving'))}
          </span>
        </div>
      )}
    </SettingsPage>
  )
}
