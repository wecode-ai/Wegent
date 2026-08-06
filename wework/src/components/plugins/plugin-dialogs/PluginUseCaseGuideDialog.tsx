import { Check, ChevronDown, MessageCircle, Plus, Sparkles, X } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface PluginUseCaseGuideDialogProps {
  pluginName: string
  title: string
  generatedPrompt: string
  confirmation: {
    question: string
    defaultOptionId: string
    options: Array<{
      id: string
      label: string
      promptValue: string
    }>
  }
  hasConversationContext?: boolean
  installed: boolean
  onClose: () => void
  onConfirm: (prompt: string) => void
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function PluginUseCaseGuideDialog({
  pluginName,
  title,
  generatedPrompt,
  confirmation,
  hasConversationContext = false,
  installed,
  onClose,
  onConfirm,
}: PluginUseCaseGuideDialogProps) {
  const { t } = useTranslation('common')
  const [selectedOptionId, setSelectedOptionId] = useState(confirmation.defaultOptionId)
  const [taskGoal, setTaskGoal] = useState(generatedPrompt)
  const [usesConversationContext, setUsesConversationContext] = useState(false)
  const [showAdditionalContext, setShowAdditionalContext] = useState(false)
  const [additionalContext, setAdditionalContext] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const initialFocusRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frameId = window.requestAnimationFrame(() => initialFocusRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frameId)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (
      document.activeElement === dialogRef.current ||
      document.activeElement === initialFocusRef.current
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const selectedOption =
    confirmation.options.find(option => option.id === selectedOptionId) ?? confirmation.options[0]
  const taskDraft = useMemo(() => {
    const lines = [taskGoal.trim()]
    if (usesConversationContext) {
      lines.push(
        t(
          'workbench.plugin_guide_task_conversation_context',
          '上下文：结合当前对话最近内容理解目标和已有材料；如果缺少关键信息，只询问一个必要问题。'
        )
      )
    }
    if (selectedOption?.promptValue.trim()) {
      lines.push(
        t('workbench.plugin_guide_task_focus', {
          focus: selectedOption.promptValue.trim(),
          defaultValue: `重点要求：${selectedOption.promptValue.trim()}`,
        })
      )
    }
    if (additionalContext.trim()) {
      lines.push(
        t('workbench.plugin_guide_task_context', {
          context: additionalContext.trim(),
          defaultValue: `补充要求：${additionalContext.trim()}`,
        })
      )
    }
    return lines.filter(Boolean).join('\n')
  }, [additionalContext, selectedOption, t, taskGoal, usesConversationContext])

  const dialog = (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center p-6"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        id="plugin-use-case-guide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-use-case-guide-title"
        tabIndex={-1}
        data-testid="plugin-use-case-guide"
        className="plugin-dialog-surface flex max-h-[calc(100vh-48px)] w-full max-w-[600px] flex-col overflow-hidden"
        onClick={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <span
          ref={initialFocusRef}
          tabIndex={-1}
          data-testid="plugin-use-case-guide-initial-focus"
          className="sr-only"
        >
          {title}
        </span>
        <header className="plugin-dialog-divider flex items-start gap-3 border-b px-6 py-5">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface text-text-secondary">
            <Sparkles className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="plugin-use-case-guide-title" className="heading-subsection text-text-primary">
              {t('workbench.plugin_guide_dialog_title', 'AI 插件使用向导')}
            </h2>
            <p className="mt-1 text-xs leading-4 text-text-muted">
              {t('workbench.plugin_guide_using_plugin', {
                plugin: pluginName,
                defaultValue: `正在使用 ${pluginName} · 确认目标后再带入聊天框`,
              })}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('common.close', '关闭')}
            data-testid="plugin-use-case-guide-collapse"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <label
              htmlFor="plugin-use-case-goal-input"
              className="block text-sm font-medium leading-5 text-text-primary"
            >
              {t('workbench.plugin_guide_goal_label', '你想让插件完成什么？')}
            </label>
            <textarea
              id="plugin-use-case-goal-input"
              value={taskGoal}
              rows={2}
              maxLength={600}
              data-testid="plugin-use-case-goal-input"
              placeholder={title}
              className="mt-2 w-full resize-y rounded-xl border border-border/30 bg-background px-3 py-2.5 text-sm leading-5 text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border/60 focus:ring-2 focus:ring-focus/10"
              onChange={event => setTaskGoal(event.target.value)}
            />
            {hasConversationContext && (
              <button
                type="button"
                aria-pressed={usesConversationContext}
                data-testid="plugin-use-case-context-suggestion"
                className={[
                  'mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20',
                  usesConversationContext ? 'bg-surface' : 'hover:bg-surface/70',
                ].join(' ')}
                onClick={() => setUsesConversationContext(current => !current)}
              >
                <Sparkles className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-5 text-text-primary">
                    {usesConversationContext
                      ? t('workbench.plugin_guide_context_enabled', '已结合当前对话')
                      : t('workbench.plugin_guide_context_action', '让 AI 结合当前对话完善')}
                  </span>
                  <span className="block text-xs leading-4 text-text-muted">
                    {t(
                      'workbench.plugin_guide_context_hint',
                      '带入聊天后，AI 会先理解近期消息和已有材料，再补全任务。'
                    )}
                  </span>
                </span>
                {usesConversationContext && (
                  <Check className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
                )}
              </button>
            )}
          </div>

          <fieldset data-testid="plugin-use-case-confirmation">
            <legend className="text-sm font-medium leading-5 text-text-primary">
              {confirmation.question}
            </legend>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
              {confirmation.options.map(option => {
                const selected = selectedOptionId === option.id
                return (
                  <label
                    key={option.id}
                    className={[
                      'flex min-h-20 cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 transition-colors',
                      selected
                        ? 'border-border/60 bg-surface text-text-primary'
                        : 'border-border/30 bg-background text-text-primary hover:border-border/45 hover:bg-surface/70',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="plugin-guide-confirmation"
                      value={option.id}
                      checked={selected}
                      data-testid={`plugin-use-case-option-${option.id}`}
                      className="sr-only"
                      onChange={() => setSelectedOptionId(option.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium leading-5">{option.label}</span>
                      <span className="mt-0.5 block text-xs leading-4 text-text-muted">
                        {option.promptValue}
                      </span>
                    </span>
                    <span
                      className={[
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                        selected
                          ? 'border-text-primary bg-text-primary text-background'
                          : 'border-border/60 text-transparent',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      <Check className="h-2.5 w-2.5" />
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div data-testid="plugin-use-case-draft">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <p className="text-sm font-medium leading-5 text-text-primary">
                {t('workbench.plugin_guide_preview_label', '将带入聊天框')}
              </p>
              <span className="text-xs leading-4 text-text-muted">
                {t('workbench.plugin_guide_preview_hint', '进入聊天后可继续修改')}
              </span>
            </div>
            <output
              data-testid="plugin-use-case-draft-input"
              className="block min-h-20 whitespace-pre-wrap rounded-xl border border-border/20 bg-surface/70 px-3 py-3 text-sm leading-5 text-text-primary"
            >
              {taskDraft}
            </output>
          </div>

          <div>
            <button
              type="button"
              aria-expanded={showAdditionalContext}
              aria-controls="plugin-use-case-additional-panel"
              data-testid="plugin-use-case-context-toggle"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-text-muted transition-colors hover:bg-surface/70 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
              onClick={() => setShowAdditionalContext(current => !current)}
            >
              {showAdditionalContext ? (
                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>{t('workbench.plugin_guide_additional_label', '补充要求（可选）')}</span>
            </button>
            {showAdditionalContext && (
              <div id="plugin-use-case-additional-panel" className="mt-2 pl-2">
                <label htmlFor="plugin-use-case-context-input" className="sr-only">
                  {t('workbench.plugin_guide_additional_label', '补充要求（可选）')}
                </label>
                <textarea
                  id="plugin-use-case-context-input"
                  value={additionalContext}
                  rows={3}
                  maxLength={400}
                  data-testid="plugin-use-case-context-input"
                  placeholder={t(
                    'workbench.plugin_guide_additional_placeholder',
                    '例如：只检查 src 目录，忽略第三方依赖，结果按严重程度排序'
                  )}
                  className="w-full resize-y rounded-xl border border-border/25 bg-background px-3 py-2.5 text-sm leading-5 text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border/60 focus:ring-2 focus:ring-focus/10"
                  onChange={event => setAdditionalContext(event.target.value)}
                />
              </div>
            )}
          </div>
        </div>

        <footer className="plugin-dialog-divider flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-4 text-text-muted">
            {installed
              ? t('workbench.plugin_guide_next_step_installed', '只会放入聊天框，不会立即执行。')
              : t(
                  'workbench.plugin_guide_next_step_install',
                  '安装后只会放入聊天框，不会立即执行。'
                )}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="plugin-use-case-guide-cancel"
              className="rounded-lg text-text-secondary hover:bg-surface hover:text-text-primary"
              onClick={onClose}
            >
              {t('common.cancel', '取消')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!taskDraft.trim()}
              data-testid="plugin-use-case-start-button"
              className="rounded-lg"
              onClick={() => onConfirm(taskDraft)}
            >
              <MessageCircle aria-hidden="true" />
              {installed
                ? t('workbench.plugin_guide_add_to_chat', '带入聊天框')
                : t('workbench.plugin_guide_install_and_add', '安装并带入聊天框')}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )

  return createPortal(dialog, document.body)
}
