import { ChevronLeft } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { focusComposerAtEnd, WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'

export interface TaskSuggestion {
  id: string
  labelKey: string
  fallbackLabel: string
  promptKey: string
  fallbackPrompt: string
}

export interface TaskSuggestionCategory {
  id: string
  labelKey: string
  fallbackLabel: string
  suggestions: TaskSuggestion[]
}

interface DesktopEmptyTaskLauncherProps {
  projectName?: string | null
  onOpenProjectSelector: (anchorElement: HTMLButtonElement) => void
  onSelectSuggestion: (prompt: string) => void
  composer: ReactNode
}

const TASK_SUGGESTION_CATEGORIES: TaskSuggestionCategory[] = [
  {
    id: 'explore',
    labelKey: 'workbench.task_suggestions.explore.label',
    fallbackLabel: '探索并理解代码',
    suggestions: [
      ['feature', '探索一个功能', '探索一个功能 '],
      ['implementation', '探索实现方案', '探索一项功能的实现方案 '],
      ['architecture', '比较架构方案', '探索并比较架构方案 '],
      ['api', '探索并记录 API', '探索并记录一个 API '],
    ].map(([id, fallbackLabel, fallbackPrompt]) => ({
      id,
      labelKey: `workbench.task_suggestions.explore.${id}`,
      fallbackLabel,
      promptKey: `workbench.task_suggestions.explore.${id}_prompt`,
      fallbackPrompt,
    })),
  },
  {
    id: 'build',
    labelKey: 'workbench.task_suggestions.build.label',
    fallbackLabel: '构建新功能、应用或工具',
    suggestions: [
      ['feature', '构建功能', '构建一项功能 '],
      ['ui', '构建 UI 更改', '构建 UI 更改 '],
      ['prototype', '构建原型', '构建一个原型 '],
      ['tool', '构建内部工具', '构建一个内部工具 '],
    ].map(([id, fallbackLabel, fallbackPrompt]) => ({
      id,
      labelKey: `workbench.task_suggestions.build.${id}`,
      fallbackLabel,
      promptKey: `workbench.task_suggestions.build.${id}_prompt`,
      fallbackPrompt,
    })),
  },
  {
    id: 'review',
    labelKey: 'workbench.task_suggestions.review.label',
    fallbackLabel: '审查代码并提出修改建议',
    suggestions: [
      ['changes', '审查我的更改', '审查我的更改并提出修改建议 '],
      ['pull_request', '审查 Pull Request', '审查一个 Pull Request '],
      ['coverage', '审查测试覆盖率', '审查测试覆盖率并补充缺失测试 '],
      ['refactor', '审查并重构代码', '审查并重构代码 '],
    ].map(([id, fallbackLabel, fallbackPrompt]) => ({
      id,
      labelKey: `workbench.task_suggestions.review.${id}`,
      fallbackLabel,
      promptKey: `workbench.task_suggestions.review.${id}_prompt`,
      fallbackPrompt,
    })),
  },
  {
    id: 'fix',
    labelKey: 'workbench.task_suggestions.fix.label',
    fallbackLabel: '修复问题和失败',
    suggestions: [
      ['bug', '修复 bug', '修复一个 bug '],
      ['tests', '修复失败测试', '修复失败的测试 '],
      ['ci', '修复 CI', '修复 CI 失败 '],
      ['conflicts', '修复合并冲突', '修复合并冲突 '],
    ].map(([id, fallbackLabel, fallbackPrompt]) => ({
      id,
      labelKey: `workbench.task_suggestions.fix.${id}`,
      fallbackLabel,
      promptKey: `workbench.task_suggestions.fix.${id}_prompt`,
      fallbackPrompt,
    })),
  },
]

export function DesktopEmptyTaskLauncher({
  projectName,
  onOpenProjectSelector,
  onSelectSuggestion,
  composer,
}: DesktopEmptyTaskLauncherProps) {
  const { t } = useTranslation('common')
  const launcherRef = useRef<HTMLElement>(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const selectedCategory = TASK_SUGGESTION_CATEGORIES.find(
    category => category.id === selectedCategoryId
  )

  useEffect(() => {
    const focusComposer = () => {
      focusComposerAtEnd(
        launcherRef.current?.querySelector<HTMLElement>('[data-testid="chat-message-input"]')
      )
    }

    focusComposer()
    window.addEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, focusComposer)
    return () => window.removeEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, focusComposer)
  }, [])

  const selectSuggestion = (prompt: string) => {
    onSelectSuggestion(prompt)
    window.requestAnimationFrame(() => {
      focusComposerAtEnd(
        launcherRef.current?.querySelector<HTMLElement>('[data-testid="chat-message-input"]')
      )
    })
  }

  return (
    <section
      ref={launcherRef}
      data-testid="desktop-empty-composer-frame"
      className="flex min-h-0 min-w-0 flex-1 flex-col px-6 pb-4 pt-4"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center pb-16">
        <div className="mx-auto flex w-[min(46rem,calc(100%_-_2rem))] min-w-0 flex-col items-center">
          <h1 className="mb-7 max-w-full text-center text-xl font-medium leading-9 tracking-normal text-text-primary">
            {projectName ? (
              <>
                {t('workbench.project_empty_title_prefix', '我们应该在')}{' '}
                <button
                  type="button"
                  data-testid="empty-project-title-button"
                  onClick={event => onOpenProjectSelector(event.currentTarget)}
                  title={t('workbench.change_project', '更改项目')}
                  className="max-w-[18rem] truncate align-bottom underline decoration-text-muted decoration-dotted underline-offset-4 transition-colors hover:text-text-secondary focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {projectName}
                </button>{' '}
                {t('workbench.project_empty_title_suffix', '中做些什么？')}
              </>
            ) : (
              t('workbench.empty_title', '我们该做什么？')
            )}
          </h1>

          {selectedCategory ? (
            <div className="flex w-full flex-col items-center" data-testid="task-suggestion-list">
              <button
                type="button"
                data-testid="task-suggestions-back-button"
                onClick={() => setSelectedCategoryId(null)}
                className="mb-3 flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary transition-colors hover:bg-muted/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('workbench.task_suggestions.back', '返回全部建议')}
              </button>
              <div className="flex flex-wrap justify-center gap-2">
                {selectedCategory.suggestions.map(suggestion => (
                  <button
                    key={suggestion.id}
                    type="button"
                    data-testid={`task-suggestion-${selectedCategory.id}-${suggestion.id}`}
                    onClick={() =>
                      selectSuggestion(t(suggestion.promptKey, suggestion.fallbackPrompt))
                    }
                    className="flex min-h-9 items-center rounded-xl bg-muted/65 px-4 text-sm leading-[18px] text-text-secondary transition-[background-color,color,transform] hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-[0.98]"
                  >
                    {t(suggestion.labelKey, suggestion.fallbackLabel)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div
              data-testid="task-suggestion-categories"
              className="flex w-full flex-wrap justify-center gap-2"
            >
              {TASK_SUGGESTION_CATEGORIES.map(category => (
                <button
                  key={category.id}
                  type="button"
                  data-testid={`task-suggestion-category-${category.id}`}
                  onClick={() => setSelectedCategoryId(category.id)}
                  className="flex min-h-9 items-center rounded-xl bg-muted/65 px-4 text-sm leading-[18px] text-text-secondary transition-[background-color,color,transform] hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-[0.98]"
                >
                  {t(category.labelKey, category.fallbackLabel)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div
        data-testid="desktop-empty-composer-dock"
        className="mx-auto w-[min(46rem,calc(100%_-_2rem))] min-w-0 shrink-0 pb-1"
      >
        {composer}
      </div>
    </section>
  )
}
