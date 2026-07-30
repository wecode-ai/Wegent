import { Bot, Loader2, Send, Sparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks } from '@/types/api'

interface DingTalkProjectAssistantProps {
  projects: ProjectWithTasks[]
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (project: ProjectWithTasks, message: string) => Promise<void>
}

export function DingTalkProjectAssistant({
  projects,
  busy,
  error,
  onClose,
  onSubmit,
}: DingTalkProjectAssistantProps) {
  const { t } = useTranslation('common')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? 0)
  const [message, setMessage] = useState('')
  const selectedProject = useMemo(
    () => projects.find(project => project.id === projectId) ?? projects[0],
    [projectId, projects]
  )

  async function submit(value = message) {
    const prompt = value.trim()
    if (!prompt || !selectedProject || busy) return
    await onSubmit(selectedProject, prompt)
    setMessage('')
  }

  return (
    <aside
      data-testid="dingtalk-project-assistant"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-background"
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-text-primary text-background">
          <Bot className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {t('todo.dingtalk_assistant_title')}
          </span>
          <span className="block truncate text-xs text-text-muted">
            {t('todo.dingtalk_assistant_subtitle')}
          </span>
        </span>
        <button
          type="button"
          data-testid="dingtalk-project-assistant-close"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
          aria-label={t('todo.dingtalk_assistant_close')}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="flex gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-text-primary text-background">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div className="text-sm leading-5 text-text-secondary">
            <p>{t('todo.dingtalk_assistant_intro')}</p>
            <p className="mt-2 text-xs text-text-muted">
              {t('todo.dingtalk_assistant_source_note')}
            </p>
          </div>
        </div>

        <p className="mt-6 text-xs text-text-muted">{t('todo.dingtalk_assistant_try')}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[
            t('todo.dingtalk_assistant_prompt_filter'),
            t('todo.dingtalk_assistant_prompt_create'),
            t('todo.dingtalk_assistant_prompt_view'),
          ].map(prompt => (
            <button
              key={prompt}
              type="button"
              disabled={!selectedProject || busy}
              onClick={() => void submit(prompt)}
              className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-muted disabled:opacity-40"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>

      <footer className="border-t border-border p-3">
        {projects.length > 1 ? (
          <select
            data-testid="dingtalk-project-assistant-workspace"
            value={selectedProject?.id ?? ''}
            onChange={event => setProjectId(Number(event.target.value))}
            className="mb-2 h-8 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus:border-focus"
            aria-label={t('todo.dingtalk_assistant_workspace')}
          >
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="rounded-2xl bg-muted/60 p-2 shadow-sm ring-1 ring-border focus-within:ring-focus/60">
          <textarea
            data-testid="dingtalk-project-assistant-input"
            value={message}
            onChange={event => setMessage(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            rows={3}
            placeholder={t('todo.dingtalk_assistant_placeholder')}
            className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-text-muted"
          />
          <div className="flex items-center gap-2 pt-1">
            <span className="min-w-0 flex-1 truncate px-1 text-xs text-text-muted">
              {selectedProject
                ? t('todo.dingtalk_assistant_runtime', { project: selectedProject.name })
                : t('todo.dingtalk_assistant_no_workspace')}
            </span>
            <button
              type="button"
              data-testid="dingtalk-project-assistant-send"
              disabled={!selectedProject || !message.trim() || busy}
              onClick={() => void submit()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-text-primary text-background hover:opacity-80 disabled:opacity-40"
              aria-label={t('todo.dingtalk_assistant_send')}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
        {error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </footer>
    </aside>
  )
}
