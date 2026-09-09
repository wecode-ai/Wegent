import { useEffect, useState } from 'react'
import type { CloudLoopItem, IssueWorkflowInstance } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

interface Props {
  item: CloudLoopItem
  api: {
    listIssueExperiences: (id: string) => Promise<Array<{ id: string; name: string }>>
    adoptIssueExperience: (
      id: string,
      automationId: string,
      intent: string
    ) => Promise<IssueWorkflowInstance>
  }
  onUpdated: () => Promise<void>
}

export function IssueExperienceMigration({ item, api, onUpdated }: Props) {
  const { t } = useTranslation()
  const [experiences, setExperiences] = useState<Array<{ id: string; name: string }>>([])
  const [selected, setSelected] = useState('')
  const [intent, setIntent] = useState(item.description || item.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api.listIssueExperiences(item.id).then(
      result => {
        if (active) setExperiences(result)
      },
      cause => {
        if (active) setError(String(cause))
      }
    )
    return () => {
      active = false
    }
  }, [api, item.id])
  const adopt = async () => {
    if (busy || !selected || !intent.trim()) return
    setBusy(true)
    setError('')
    try {
      await api.adoptIssueExperience(item.id, selected, intent.trim())
      await onUpdated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-4 space-y-3 text-sm" data-testid="issue-experience-migration">
      <p>{t('todo.experience_migration_hint')}</p>
      <label className="block">
        {t('todo.experience_select')}
        <select
          className="mt-1 block w-full rounded-lg border border-border bg-background p-2"
          data-testid="issue-experience-select"
          value={selected}
          disabled={busy}
          onChange={event => setSelected(event.target.value)}
        >
          <option value="">{t('todo.experience_select')}</option>
          {experiences.map(experience => (
            <option key={experience.id} value={experience.id}>
              {experience.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        {t('todo.assignment_intent')}
        <textarea
          className="mt-1 block min-h-20 w-full rounded-lg border border-border bg-background p-2"
          data-testid="issue-experience-intent"
          value={intent}
          disabled={busy}
          onChange={event => setIntent(event.target.value)}
        />
      </label>
      <button
        type="button"
        data-testid="issue-experience-adopt"
        className="rounded-lg bg-text-primary px-3 py-1.5 text-background disabled:opacity-40"
        disabled={busy || !selected || !intent.trim()}
        onClick={() => void adopt()}
      >
        {t('todo.experience_adopt')}
      </button>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
