import {
  ArrowRight,
  BookOpenText,
  ChevronDown,
  ChevronUp,
  ListChecks,
  LoaderCircle,
  PencilLine,
  Sparkles,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type {
  LocalDeviceApp,
  PluginPathComponent,
} from '@wegent/chat-core/runtime-composer-catalog'
import type { CollaborationTranslate } from '../i18n'

function pluginTemplateDisplayTitle(
  template: PluginPathComponent,
  t: CollaborationTranslate
): string {
  const source = `${template.name} ${template.description ?? ''}`.toLowerCase()
  if (/working[- ]tree|current workspace|当前工作区|当前改动/.test(source)) {
    return t('workbench.plugin_trial_review_current_changes', '当前改动')
  }
  if (/merge base|compare.*branch|分支.*对比|合并基线/.test(source)) {
    return t('workbench.plugin_trial_review_branch', '分支对比')
  }
  if (/this commit|single commit|单次提交|这次提交/.test(source)) {
    return t('workbench.plugin_trial_review_commit', '单次提交')
  }
  return template.name
}

export function PluginTrialTemplateStrip({
  translate: t,
  renderPluginIcon,
  templates,
  pluginName,
  pluginApp,
  draft,
  hasConversationContext = false,
  onApplyTemplate,
  onRefinePrompt,
  onApplyRefinedPrompt,
  onDismiss,
}: {
  translate: CollaborationTranslate
  renderPluginIcon: (
    app: LocalDeviceApp,
    props: { className: string; testId?: string }
  ) => ReactNode
  templates: PluginPathComponent[]
  pluginName?: string
  pluginApp?: LocalDeviceApp
  draft: string
  hasConversationContext?: boolean
  onApplyTemplate: (template: PluginPathComponent) => void
  onRefinePrompt?: (draft: string) => Promise<string>
  onApplyRefinedPrompt?: (prompt: string) => void
  onDismiss?: () => void
}) {
  const availableTemplates = templates.filter(template => !template.unavailableReason).slice(0, 6)
  const [showOtherTasks, setShowOtherTasks] = useState(false)
  const [refinedPrompt, setRefinedPrompt] = useState('')
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState('')
  const primaryTemplates = availableTemplates.slice(0, 3)
  const otherTemplates = availableTemplates.slice(3)
  const taskIcons = [PencilLine, BookOpenText, ListChecks]

  if (!pluginName && availableTemplates.length === 0) return null
  if (availableTemplates.length === 0 && !onRefinePrompt) return null

  const refine = async () => {
    if (!onRefinePrompt || refining) return
    setRefining(true)
    setRefineError('')
    try {
      setRefinedPrompt(await onRefinePrompt(draft))
      setShowOtherTasks(false)
    } catch (error) {
      setRefineError(
        error instanceof Error
          ? error.message
          : t('workbench.plugin_trial_ai_error', 'AI 暂时无法完善任务，请重试')
      )
    } finally {
      setRefining(false)
    }
  }

  const applyRecommendation = () => {
    if (refinedPrompt) {
      onApplyRefinedPrompt?.(refinedPrompt)
      return
    }
    if (availableTemplates[0]) {
      onApplyTemplate(availableTemplates[0])
      return
    }
    void refine()
  }

  const renderTemplateRow = (template: PluginPathComponent, index: number) => {
    const TaskIcon = taskIcons[index % taskIcons.length]
    const isPrimaryRecommendation = !refinedPrompt && index === 0
    const displayTitle = pluginTemplateDisplayTitle(template, t)

    return (
      <button
        key={template.path}
        type="button"
        data-testid={
          isPrimaryRecommendation
            ? 'plugin-trial-recommendation-apply'
            : 'plugin-trial-template-card'
        }
        className="group relative flex min-h-10 max-md:min-h-11 w-full items-center gap-2.5 border-b border-border/15 px-3 py-1.5 text-left transition-colors last:border-b-0 hover:bg-blue-500/[0.08] focus-visible:bg-blue-500/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
        onClick={() => onApplyTemplate(template)}
        aria-label={t('workbench.plugin_trial_apply_task', '填入任务：{{task}}', {
          task: displayTitle,
        }).replace('{{task}}', displayTitle)}
      >
        <span
          className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        />
        <TaskIcon
          className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300"
          aria-hidden="true"
        />
        {pluginName && (
          <span className="shrink-0 text-sm font-medium leading-5 text-blue-600 dark:text-blue-300">
            {pluginName}
          </span>
        )}
        <strong
          className="min-w-0 flex-1 truncate text-sm font-normal leading-5 text-text-primary"
          data-testid={isPrimaryRecommendation ? 'plugin-trial-recommendation-title' : undefined}
        >
          {displayTitle}
        </strong>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/30 bg-background text-text-secondary transition-colors group-hover:border-blue-500/60 group-hover:bg-blue-500/[0.1] group-hover:text-blue-600 group-focus-visible:border-blue-500/60 group-focus-visible:bg-blue-500/[0.1] group-focus-visible:text-blue-600">
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
    )
  }

  return (
    <section
      className="mx-auto mb-2 max-w-[760px] overflow-hidden rounded-xl border border-border/25 bg-background shadow-md"
      data-testid="plugin-trial-template-strip"
      aria-label={t('workbench.plugin_trial_examples_accessible_label', '插件常用任务')}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {pluginApp ? (
            renderPluginIcon(pluginApp, {
              className:
                'flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/30 bg-background',
              testId: 'plugin-trial-plugin-icon',
            })
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
          )}
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="shrink-0 text-sm font-medium leading-5 text-text-primary">
              {pluginName
                ? t('workbench.plugin_trial_examples_title', '{{plugin}} 可以这样用', {
                    plugin: pluginName,
                  }).replace('{{plugin}}', pluginName)
                : t('workbench.plugin_trial_examples_fallback_title', '这个插件可以这样用')}
            </h3>
            <p className="truncate text-xs leading-4 text-text-muted">
              {t('workbench.plugin_trial_examples_hint', '选择一个常用任务，填入后仍可修改')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onDismiss && (
            <button
              type="button"
              data-testid="plugin-trial-template-dismiss"
              aria-label={t('common.close', '关闭')}
              className="flex h-7 w-7 max-md:h-11 max-md:w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
              onClick={onDismiss}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="px-2 pb-2">
        <div
          className="overflow-hidden rounded-lg border border-border/20"
          data-testid={refinedPrompt ? 'plugin-trial-ai-result' : 'plugin-trial-recommendation'}
        >
          {refinedPrompt && (
            <button
              type="button"
              data-testid="plugin-trial-recommendation-apply"
              className="group relative flex min-h-10 max-md:min-h-11 w-full items-center gap-2.5 border-b border-border/15 bg-blue-500/[0.04] px-3 py-1.5 text-left transition-colors hover:bg-blue-500/[0.1] focus-visible:bg-blue-500/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
              onClick={applyRecommendation}
            >
              <span
                className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden="true"
              />
              <Sparkles
                className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300"
                aria-hidden="true"
              />
              <span className="shrink-0 text-sm font-medium leading-5 text-blue-600 dark:text-blue-300">
                {t('workbench.plugin_trial_ai_result', 'AI 整理的任务')}
              </span>
              <strong
                className="min-w-0 flex-1 truncate text-sm font-normal leading-5 text-text-primary"
                data-testid="plugin-trial-recommendation-title"
              >
                {refinedPrompt}
              </strong>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/30 bg-background text-text-secondary transition-colors group-hover:border-blue-500/60 group-hover:bg-blue-500/[0.1] group-hover:text-blue-600 group-focus-visible:border-blue-500/60 group-focus-visible:bg-blue-500/[0.1] group-focus-visible:text-blue-600">
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          )}
          {primaryTemplates.map(renderTemplateRow)}
          {showOtherTasks && otherTemplates.length > 0 && (
            <div className="contents" data-testid="plugin-trial-other-tasks">
              {otherTemplates.map((template, index) =>
                renderTemplateRow(template, primaryTemplates.length + index)
              )}
            </div>
          )}
          {availableTemplates.length === 0 && (
            <button
              type="button"
              data-testid="plugin-trial-recommendation-apply"
              className="group relative flex min-h-10 max-md:min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-blue-500/[0.08] focus-visible:bg-blue-500/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void refine()}
              disabled={!onRefinePrompt || refining}
            >
              <span
                className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden="true"
              />
              <Sparkles
                className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300"
                aria-hidden="true"
              />
              <strong
                className="min-w-0 flex-1 text-sm font-normal leading-5 text-text-primary"
                data-testid="plugin-trial-recommendation-title"
              >
                {t(
                  'workbench.plugin_trial_ai_empty_recommendation',
                  '让 AI 推荐一个适合当前目标的任务'
                )}
              </strong>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/30 bg-background text-text-secondary transition-colors group-hover:border-blue-500/60 group-hover:bg-blue-500/[0.1] group-hover:text-blue-600 group-focus-visible:border-blue-500/60 group-focus-visible:bg-blue-500/[0.1] group-focus-visible:text-blue-600">
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          )}
        </div>
        {refineError && (
          <div
            className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs leading-4 text-red-700"
            role="alert"
            data-testid="plugin-trial-ai-error"
          >
            <span>{refineError}</span>
            <button
              type="button"
              data-testid="plugin-trial-ai-retry"
              className="min-h-7 max-md:min-h-11 shrink-0 font-medium hover:underline"
              onClick={() => void refine()}
            >
              {t('workbench.retry', '重试')}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-1 px-1 pt-1.5 text-xs leading-4 text-text-muted">
          <span>
            {t('workbench.plugin_trial_examples_footer', '点击只会填入输入框，不会自动发送')}
          </span>
          <span className="flex items-center gap-1">
            {otherTemplates.length > 0 && (
              <button
                type="button"
                data-testid="plugin-trial-other-tasks-toggle"
                aria-expanded={showOtherTasks}
                className="inline-flex h-7 max-md:h-11 items-center gap-1 rounded-md px-1.5 font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
                onClick={() => setShowOtherTasks(current => !current)}
              >
                {showOtherTasks
                  ? t('workbench.plugin_trial_hide_other_tasks', '收起其他任务')
                  : t('workbench.plugin_trial_view_other_tasks', '查看其他常用任务')}
                {showOtherTasks ? (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            )}
            {onRefinePrompt && (
              <button
                type="button"
                data-testid="plugin-trial-ai-refine"
                className="inline-flex h-7 max-md:h-11 items-center gap-1.5 rounded-md px-1.5 font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void refine()}
                disabled={refining}
                aria-label={
                  hasConversationContext
                    ? t(
                        'workbench.plugin_trial_ai_other_task_with_context',
                        '结合当前对话推荐其他任务'
                      )
                    : t('workbench.plugin_trial_ai_other_task', 'AI 推荐其他任务')
                }
              >
                {refining ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {refining
                  ? t('workbench.plugin_trial_ai_refining', 'AI 正在推荐…')
                  : t('workbench.plugin_trial_ai_other_task', 'AI 推荐其他任务')}
              </button>
            )}
          </span>
        </div>
      </div>
    </section>
  )
}
