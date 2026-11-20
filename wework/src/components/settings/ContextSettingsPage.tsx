import {
  getLocalCodexInstructions,
  saveLocalCodexInstructions,
} from '@/api/local/codexInstructions'
import {
  clampContextCompactionThreshold,
  CONTEXT_COMPACTION_THRESHOLD_MAX,
  CONTEXT_COMPACTION_THRESHOLD_MIN,
  defaultAppPreferences,
  getAppPreferences,
  USER_PREFERENCE_PROMPT_MAX_LENGTH,
  updateAppPreferences,
  type AppPreferencesPatch,
} from '@/desktop/appPreferences'
import { useTranslation } from '@/hooks/useTranslation'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Check, Loader2, Save, Terminal } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { CodexPersonalitySettings } from './CodexPersonalitySettings'
import { SettingsPage, SettingsPageHeader, SettingsRow, SettingsSwitch } from './settings-ui'

export function ContextSettingsPage() {
  const { t } = useTranslation('common')
  const [preferencesResource] = useState(() =>
    createAsyncResource('settings/context-preferences', () => getAppPreferences())
  )
  const [instructionsResource] = useState(() =>
    createAsyncResource('settings/context-instructions', () => getLocalCodexInstructions())
  )
  const preferencesSnapshot = useSyncExternalStore(
    preferencesResource.subscribe,
    preferencesResource.getSnapshot
  )
  const instructionsSnapshot = useSyncExternalStore(
    instructionsResource.subscribe,
    instructionsResource.getSnapshot
  )
  const preferences = preferencesSnapshot.data ?? defaultAppPreferences
  const loading = !preferencesSnapshot.settled
  const instructionsLoading = !instructionsSnapshot.settled
  const [saving, setSaving] = useState(false)
  const preferencesPending = useRef(false)
  const instructionsPending = useRef(false)
  const [saveError, setError] = useState<string | null>(null)
  const error =
    saveError ??
    (preferencesSnapshot.status === 'error' ? t('workbench.context_settings_load_failed') : null)
  const [instructionsDraft, setInstructions] = useState<string | null>(null)
  const savedInstructions = instructionsSnapshot.data?.instructions ?? ''
  const instructions = instructionsDraft ?? savedInstructions
  const [userPreferenceDraft, setUserPreferenceDraft] = useState<string | null>(null)
  const savedUserPreferencePrompt = preferences.userPreferencePrompt
  const userPreferencePrompt = userPreferenceDraft ?? savedUserPreferencePrompt
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [instructionsSaved, setInstructionsSaved] = useState(false)
  const [instructionsSaveError, setInstructionsError] = useState<string | null>(null)
  const instructionsError =
    instructionsSaveError ??
    (instructionsSnapshot.status === 'error'
      ? t('workbench.context_settings_wework_instructions_load_failed')
      : null)
  const [supervisorDraft, setSupervisorPrinciples] = useState<string | null>(null)
  const savedSupervisorPrinciples = preferences.supervisorPrinciples
  const supervisorPrinciples = supervisorDraft ?? savedSupervisorPrinciples
  const [thresholdDraft, setCompactionThresholdDraft] = useState<string | null>(null)
  const compactionThresholdDraft = thresholdDraft ?? String(preferences.contextCompactionThreshold)
  const instructionsDirty = instructions !== savedInstructions

  const savePreferences = async (patch: AppPreferencesPatch, optimistic = false) => {
    if (preferencesPending.current) return
    preferencesPending.current = true
    setSaving(true)
    setError(null)
    const previous = preferencesResource.getSnapshot().data
    if (optimistic && previous) preferencesResource.update(() => ({ ...previous, ...patch }))
    try {
      const receipt = await updateAppPreferences(patch)
      preferencesResource.update(() => receipt)
      return receipt
    } catch (saveError) {
      if (optimistic && previous) preferencesResource.update(() => previous)
      console.error('[Wework] Failed to update context settings', saveError)
      setError(t('workbench.context_settings_save_failed'))
    } finally {
      preferencesPending.current = false
      setSaving(false)
    }
  }

  const handleTerminalContextChange = async (enabled: boolean) => {
    await savePreferences({ terminalContextInjectionEnabled: enabled }, true)
  }

  const handleSaveInstructions = async () => {
    if (instructionsPending.current) return
    instructionsPending.current = true
    setInstructionsSaving(true)
    setInstructionsSaved(false)
    setInstructionsError(null)
    const submitted = instructions
    try {
      const receipt = await saveLocalCodexInstructions(submitted)
      instructionsResource.update(() => receipt)
      setInstructions(current => (current === submitted ? null : current))
      setInstructionsSaved(true)
    } catch (saveError) {
      console.error('[Wework] Failed to save Wework custom instructions', saveError)
      setInstructionsError(t('workbench.context_settings_wework_instructions_save_failed'))
    } finally {
      instructionsPending.current = false
      setInstructionsSaving(false)
    }
  }

  const handleSaveUserPreferencePrompt = async () => {
    const submitted = userPreferencePrompt.trim()
    if (submitted.length > USER_PREFERENCE_PROMPT_MAX_LENGTH) {
      setError(t('workbench.context_settings_user_preference_prompt_too_long'))
      return
    }
    if (submitted === savedUserPreferencePrompt) return
    try {
      const receipt = await updateAppPreferences({ userPreferencePrompt: submitted })
      preferencesResource.update(() => receipt)
      setUserPreferenceDraft(current => (current === userPreferencePrompt ? null : current))
    } catch (saveError) {
      console.error('[Wework] Failed to save user preference prompt', saveError)
      setError(t('workbench.context_settings_user_preference_prompt_save_failed'))
    }
  }

  const handleSaveSupervisorPrinciples = async () => {
    const submitted = supervisorPrinciples
    const receipt = await savePreferences({ supervisorPrinciples: submitted })
    if (receipt) setSupervisorPrinciples(current => (current === submitted ? null : current))
  }

  const commitCompactionThreshold = async () => {
    if (preferencesPending.current) return
    const raw = compactionThresholdDraft.trim()
    const parsed = raw === '' ? NaN : Number(raw)
    const nextValue = Number.isFinite(parsed)
      ? clampContextCompactionThreshold(parsed)
      : preferences.contextCompactionThreshold
    const submitted = String(nextValue)
    setCompactionThresholdDraft(submitted)
    if (nextValue === preferences.contextCompactionThreshold) return
    const receipt = await savePreferences({ contextCompactionThreshold: nextValue })
    if (receipt) setCompactionThresholdDraft(current => (current === submitted ? null : current))
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

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <SettingsRow
          data-testid="context-compaction-threshold-row"
          label={t('workbench.context_settings_compaction_threshold')}
          description={t('workbench.context_settings_compaction_threshold_description')}
          children={
            <div className="flex items-center gap-2">
              <ControlInput
                type="number"
                min={CONTEXT_COMPACTION_THRESHOLD_MIN}
                max={CONTEXT_COMPACTION_THRESHOLD_MAX}
                data-testid="context-compaction-threshold-input"
                value={compactionThresholdDraft}
                onChange={event => setCompactionThresholdDraft(event.target.value)}
                onBlur={() => void commitCompactionThreshold()}
                onKeyDown={event => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                disabled={loading || saving}
                className="w-20 text-base [appearance:textfield] disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="text-sm text-text-secondary">%</span>
            </div>
          }
        />
      </section>

      <CodexPersonalitySettings />

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.context_settings_user_preference_prompt_title')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_user_preference_prompt_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="context-user-preference-prompt-save-button"
            disabled={loading || userPreferencePrompt.trim() === savedUserPreferencePrompt}
            onClick={() => void handleSaveUserPreferencePrompt()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium leading-[18px] text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            <span>{t('workbench.context_settings_user_preference_prompt_save')}</span>
          </button>
        </div>
        <div className="px-4 py-4">
          <textarea
            data-testid="context-user-preference-prompt-textarea"
            value={userPreferencePrompt}
            maxLength={USER_PREFERENCE_PROMPT_MAX_LENGTH}
            disabled={loading}
            onChange={event => setUserPreferenceDraft(event.target.value)}
            placeholder={t('workbench.context_settings_user_preference_prompt_placeholder')}
            className="min-h-32 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted keyboard:focus:border-primary"
          />
          <p className="mt-3 text-xs leading-5 text-text-secondary">
            {t('workbench.context_settings_user_preference_prompt_hint')}
          </p>
        </div>
      </section>

      {preferences.experimentalFeaturesEnabled && (
        <section className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary">
                {t('workbench.context_settings_supervisor_title')}
              </h2>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {t('workbench.context_settings_supervisor_description')}
              </p>
            </div>
            <ControlButton
              variant="primary"
              size="sm"
              type="button"
              data-testid="context-supervisor-principles-save-button"
              disabled={saving || supervisorPrinciples === savedSupervisorPrinciples}
              onClick={() => void handleSaveSupervisorPrinciples()}
              className="shrink-0"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span>{t('workbench.context_settings_supervisor_save')}</span>
            </ControlButton>
          </div>
          <div className="px-4 py-4">
            <ControlTextarea
              data-testid="context-supervisor-principles-textarea"
              value={supervisorPrinciples}
              onChange={event => setSupervisorPrinciples(event.target.value)}
              placeholder={t('workbench.context_settings_supervisor_placeholder')}
              className="min-h-32 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted keyboard:focus:border-primary"
            />
            <p className="mt-3 text-xs leading-5 text-text-secondary">
              {t('workbench.context_settings_supervisor_hint')}
            </p>
          </div>
        </section>
      )}

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
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            data-testid="context-wework-instructions-save-button"
            disabled={instructionsLoading || instructionsSaving || !instructionsDirty}
            onClick={() => void handleSaveInstructions()}
            className="shrink-0"
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
          </ControlButton>
        </div>
        <div className="px-4 py-4">
          {instructionsLoading ? (
            <div className="flex min-h-40 items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading', '加载中...')}
            </div>
          ) : (
            <ControlTextarea
              data-testid="context-wework-instructions-textarea"
              value={instructions}
              onChange={event => {
                setInstructions(event.target.value)
                setInstructionsSaved(false)
              }}
              placeholder={t('workbench.context_settings_wework_instructions_placeholder')}
              className="min-h-40 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted keyboard:focus:border-primary"
            />
          )}
          {instructionsError ? (
            <p
              data-testid="context-wework-instructions-error"
              className="mt-3 text-xs text-destructive wework:text-red-500"
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
