import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import {
  DEFAULT_CODEX_PERSONALITY,
  getLocalCodexPersonality,
  saveLocalCodexPersonality,
  type CodexPersonality,
} from '@/features/model-settings/localCodexSettings'
import { useTranslation } from '@/hooks/useTranslation'

const PERSONALITIES: CodexPersonality[] = ['friendly', 'pragmatic']

export function CodexPersonalitySettings() {
  const { t } = useTranslation('common')
  const [personality, setPersonality] = useState<CodexPersonality>(DEFAULT_CODEX_PERSONALITY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void getLocalCodexPersonality()
      .then(value => {
        if (!cancelled) setPersonality(value)
      })
      .catch(error => console.error('[Wework] Failed to read Codex personality', error))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [open])

  const selectPersonality = async (nextPersonality: CodexPersonality) => {
    const previousPersonality = personality
    setPersonality(nextPersonality)
    setOpen(false)
    setSaving(true)
    try {
      setPersonality(await saveLocalCodexPersonality(nextPersonality))
    } catch (error) {
      setPersonality(previousPersonality)
      console.error('[Wework] Failed to write Codex personality', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-background px-4 py-4">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.codex_personality_title')}
          </h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t('workbench.codex_personality_description')}
          </p>
        </div>

        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            data-testid="codex-personality-select"
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={loading || saving}
            onClick={() => setOpen(current => !current)}
            className="inline-flex h-8 min-w-[104px] items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-text-primary transition-colors hover:bg-muted"
          >
            <span>{t(`workbench.codex_personality_${personality}`)}</span>
            {loading || saving ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
            ) : (
              <ChevronDown
                className={`h-4 w-4 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
              />
            )}
          </button>

          {open ? (
            <div
              role="listbox"
              aria-label={t('workbench.codex_personality_title')}
              className="absolute right-0 top-10 z-50 w-64 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-lg"
            >
              {PERSONALITIES.map(option => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={personality === option}
                  data-testid={`codex-personality-option-${option}`}
                  onClick={() => void selectPersonality(option)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-surface"
                >
                  <span>
                    <span className="block text-sm font-medium text-text-primary">
                      {t(`workbench.codex_personality_${option}`)}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                      {t(`workbench.codex_personality_${option}_description`)}
                    </span>
                  </span>
                  {personality === option ? (
                    <Check className="ml-3 h-4 w-4 shrink-0 text-text-primary" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
