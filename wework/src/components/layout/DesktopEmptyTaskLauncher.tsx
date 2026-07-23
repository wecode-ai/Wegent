import { Bot, ChevronLeft } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type SVGProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { focusComposerAtEnd, WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import { cn } from '@/lib/utils'
import styles from './DesktopEmptyTaskLauncher.module.css'

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
  tone: 'blue' | 'purple' | 'green' | 'orange'
  suggestions: TaskSuggestion[]
}

interface DesktopEmptyTaskLauncherProps {
  projectName?: string | null
  onOpenProjectSelector: (anchorElement: HTMLButtonElement) => void
  onSelectSuggestion: (prompt: string) => void
  composer: ReactNode
}

function ExploreSuggestionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M11.5171 11.9924C11.5171 11.1544 10.8375 10.4749 9.99951 10.4748C9.1614 10.4748 8.48194 11.1543 8.48194 11.9924C8.48204 12.8304 9.16146 13.51 9.99951 13.51C10.8375 13.5099 11.517 12.8304 11.5171 11.9924ZM3.80713 8.71018C3.28699 8.92666 3.01978 9.50634 3.19385 10.0422L3.52686 11.0647L3.56494 11.1653C3.77863 11.6537 4.32351 11.9188 4.84717 11.7717L7.30322 11.0803C7.68362 9.95526 8.74606 9.14475 9.99951 9.14475C10.6946 9.14479 11.3313 9.39406 11.8257 9.80783L13.0933 9.45139L13.0278 9.28049L11.7671 5.40061L3.80713 8.71018ZM14.5962 3.05783L14.4683 3.08615L13.6382 3.35569C13.0705 3.54027 12.7594 4.15025 12.9438 4.71799L14.2935 8.86936L14.3325 8.97287C14.5537 9.47408 15.1235 9.73664 15.6558 9.56369L16.4858 9.29319L16.605 9.24045C16.8285 9.11361 16.9562 8.86404 16.9272 8.60861L16.8999 8.48166L15.2808 3.49924C15.1844 3.20321 14.894 3.02422 14.5962 3.05783ZM12.8472 11.9924C12.8471 12.9213 12.3997 13.7432 11.7114 14.2629L13.6187 17.3137L13.6782 17.4348C13.7863 17.7246 13.6802 18.0603 13.4077 18.2307C13.1352 18.401 12.7869 18.3493 12.5737 18.1252L12.4907 18.0188L10.4761 14.7961C10.3209 14.8223 10.1621 14.84 9.99951 14.8401C9.83597 14.8401 9.67603 14.8226 9.52002 14.7961L7.50635 18.0188L7.42334 18.1252C7.21015 18.3493 6.86184 18.401 6.58936 18.2307C6.27803 18.036 6.1838 17.6251 6.37842 17.3137L8.28467 14.2619C7.72379 13.8376 7.32535 13.2124 7.19776 12.4914L5.20752 13.052C4.03967 13.3804 2.82407 12.7896 2.34717 11.7004L2.26221 11.4758L1.9292 10.4533C1.54076 9.25785 2.13665 7.9642 3.29737 7.48166L11.5884 4.03342C11.7179 3.15622 12.3266 2.38379 13.2271 2.09104L14.0581 1.82053L14.2524 1.76779C15.2307 1.5561 16.2295 2.11668 16.5454 3.08908L18.1646 8.07053L18.2173 8.26584C18.4145 9.17874 17.9401 10.1097 17.0855 10.4865L16.897 10.5588L16.0659 10.8283C15.3549 11.0592 14.6144 10.9419 14.0288 10.5705L12.6499 10.9572C12.7754 11.2783 12.8472 11.6269 12.8472 11.9924Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CreateSuggestionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.16121 2.39209C8.99116 1.41315 13.0306 1.69306 15.4639 4.98584C15.879 5.54771 15.9209 6.17494 15.9561 6.59228C15.9956 7.06016 16.0289 7.30593 16.1807 7.51611C16.2172 7.56659 16.2654 7.61691 16.4366 7.78857H16.9932L17.1231 7.80127C17.2509 7.8268 17.3694 7.88939 17.463 7.98291L18.297 8.81592C18.4216 8.94061 18.4913 9.11032 18.4913 9.28662C18.4912 9.46265 18.4213 9.63177 18.297 9.75635L14.963 13.0903C14.8384 13.2147 14.6693 13.2846 14.4932 13.2847C14.317 13.2846 14.1472 13.2149 14.0225 13.0903L13.1895 12.2563C13.065 12.1317 12.9943 11.9628 12.9942 11.7866V11.2349C12.7481 11.021 12.4812 10.9087 12.1602 10.8491C12.1358 10.8947 12.1083 10.9398 12.0723 10.98L6.56062 17.1401C5.45268 18.3783 3.5316 18.4318 2.35652 17.2573C1.18145 16.0822 1.23527 14.1603 2.47371 13.0522L8.45418 7.70166C8.57406 6.7548 8.31703 6.07958 7.80769 5.49756C7.22003 4.8262 6.27589 4.25508 5.0284 3.63135C4.78035 3.50714 4.63566 3.24118 4.66511 2.96533C4.69478 2.68957 4.89257 2.46098 5.16121 2.39209ZM3.36043 14.0435C2.69112 14.6423 2.66211 15.6807 3.29695 16.3159C3.93209 16.9506 4.97053 16.9225 5.56941 16.2534L10.6612 10.562L9.05086 8.95166L3.36043 14.0435ZM14.3946 5.77588C12.7626 3.56741 10.1696 2.93747 7.23738 3.33545C7.84388 3.71889 8.38413 4.13744 8.80867 4.62256C9.55689 5.47768 9.92631 6.50958 9.78035 7.80029L11.4356 9.45556C12.213 9.46665 13.1163 9.55726 13.9044 10.2642C14.1985 10.5282 14.3243 10.895 14.3243 11.2319V11.5103L14.4923 11.6792L16.8848 9.28564L16.7169 9.11767H16.1593C15.9831 9.11755 15.8141 9.04786 15.6895 8.92334L15.5421 8.77588C15.3624 8.59624 15.2199 8.45619 15.1036 8.29541C14.7013 7.739 14.6653 7.11137 14.6309 6.70361C14.5923 6.24528 14.5552 5.99335 14.3946 5.77588Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ReviewSuggestionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M2.4763 10.2725C2.84034 10.2274 3.1729 10.4856 3.21849 10.8496C3.64002 14.2211 6.52388 16.8328 10.0202 16.833C12.1206 16.8329 14.0404 15.8898 15.3122 14.4111H12.9206C12.5534 14.4111 12.2556 14.1134 12.2556 13.7461C12.2558 13.379 12.5535 13.0811 12.9206 13.0811H16.1706C16.8136 13.0814 17.3354 13.6031 17.3357 14.2461V17.4961C17.3357 17.8631 17.0376 18.1608 16.6706 18.1611C16.3034 18.1611 16.0056 17.8634 16.0056 17.4961V15.6221C14.4954 17.1869 12.3511 18.163 10.0202 18.1631C5.84706 18.1629 2.40213 15.0456 1.89818 11.0146C1.85272 10.6503 2.11194 10.318 2.4763 10.2725Z"
        fill="currentColor"
      />
      <path
        d="M11.9548 7.41113C12.1512 7.10084 12.5625 7.00872 12.8728 7.20508C13.1821 7.4017 13.2748 7.81212 13.0788 8.12207L10.1413 12.7646C10.1084 12.8167 10.0609 12.8936 10.0124 12.957C9.96117 13.0241 9.86206 13.1404 9.70091 13.2197C9.50729 13.3148 9.28442 13.3343 9.07689 13.2754C8.90449 13.2263 8.78693 13.1292 8.72435 13.0723C8.66561 13.0187 8.60492 12.9516 8.56322 12.9062L6.99583 11.2012C6.74739 10.9308 6.76471 10.5103 7.0349 10.2617C7.3052 10.0135 7.72585 10.0308 7.97435 10.3008L9.24779 11.6875L11.9548 7.41113Z"
        fill="currentColor"
      />
      <path
        d="M3.33665 1.83594C3.70372 1.83618 4.00169 2.13386 4.00169 2.50098V4.38086C5.51126 2.81443 7.65649 1.83797 9.98802 1.83789C14.1589 1.83824 17.6027 4.95425 18.1062 8.9834C18.1514 9.3474 17.892 9.67973 17.5281 9.72559C17.1638 9.77085 16.8314 9.51171 16.7859 9.14746C16.3646 5.77798 13.4818 3.16832 9.98802 3.16797C7.89024 3.16806 5.97294 4.1095 4.70189 5.58594H7.08665C7.45372 5.58618 7.75169 5.88386 7.75169 6.25098C7.75169 6.6181 7.45372 6.91577 7.08665 6.91602H3.83665C3.19345 6.91577 2.67162 6.39424 2.67162 5.75098V2.50098C2.67162 2.13386 2.9696 1.83618 3.33665 1.83594Z"
        fill="currentColor"
      />
    </svg>
  )
}

function FixSuggestionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.2168 1.00076C10.4051 0.780861 10.7367 0.754321 10.957 0.942163C11.1773 1.13034 11.2034 1.46196 11.0156 1.6824L10.2764 2.54763C10.7067 3.06638 10.9657 3.73377 10.9658 4.46072C10.9658 4.61885 10.9515 4.77455 10.9277 4.92654C12.679 5.93944 13.8582 7.83132 13.8584 9.99978C13.8584 12.0975 12.7556 13.9373 11.1006 14.9715C10.6866 15.2301 10.1715 15.0344 9.99316 14.6209L9.85742 14.3074C9.28431 14.5436 8.65772 14.6755 8.00098 14.6756C7.34382 14.6756 6.71612 14.5438 6.14258 14.3074L6.00781 14.6209C5.82956 15.0345 5.31438 15.23 4.90039 14.9715C3.24529 13.9373 2.1416 12.0975 2.1416 9.99978C2.14176 7.8317 3.32042 5.93957 5.07129 4.92654C5.04749 4.77459 5.03418 4.61878 5.03418 4.46072C5.03431 3.73352 5.29295 3.06548 5.72363 2.54666L4.98535 1.6824C4.79734 1.46196 4.82363 1.13041 5.04395 0.942163C5.26432 0.754515 5.59599 0.780733 5.78418 1.00076L6.52734 1.8699C6.96102 1.61938 7.46319 1.47442 8 1.47439C8.53701 1.47439 9.03888 1.62021 9.47266 1.87087L10.2168 1.00076ZM7.47559 5.22048C5.87879 5.39381 4.51705 6.34902 3.78027 7.69509C3.95007 7.62307 4.13696 7.58379 4.33301 7.58376C5.11527 7.58376 5.74976 8.21758 5.75 8.99978C5.75 9.78218 5.11541 10.4168 4.33301 10.4168C3.86665 10.4167 3.4544 10.1903 3.19629 9.84255C3.19461 9.89477 3.19239 9.94715 3.19238 9.99978C3.19238 11.5997 3.97406 13.0167 5.17773 13.8914L7.47559 8.55837V5.22048ZM8.52539 8.55837L10.8223 13.8914C12.0262 13.0167 12.8086 11.5999 12.8086 9.99978C12.8086 9.94682 12.8054 9.89413 12.8037 9.84158C12.5457 10.1897 12.1336 10.4167 11.667 10.4168C10.8846 10.4168 10.25 9.78218 10.25 8.99978C10.2502 8.21758 10.8847 7.58376 11.667 7.58376C11.8632 7.58381 12.0499 7.62394 12.2197 7.69607C11.483 6.34987 10.1222 5.39392 8.52539 5.22048V8.55837ZM6.55762 13.3426C7.00287 13.5242 7.48978 13.6258 8.00098 13.6258C8.51191 13.6257 8.99747 13.5231 9.44238 13.3416L8 9.99294L6.55762 13.3426ZM8 2.52517C6.94642 2.52526 6.08525 3.38763 6.08496 4.46072V4.46267C6.68514 4.25509 7.32928 4.14142 8 4.14138C8.67074 4.14138 9.31486 4.25511 9.91504 4.46267L9.91602 4.46072C9.91572 3.38758 9.05365 2.52517 8 2.52517Z"
        fill="currentColor"
      />
    </svg>
  )
}

const CATEGORY_ICONS = {
  blue: ExploreSuggestionIcon,
  purple: CreateSuggestionIcon,
  green: ReviewSuggestionIcon,
  orange: FixSuggestionIcon,
}

const CATEGORY_TONES = {
  blue: 'text-[#0285FF]',
  purple: 'text-[#924FF7]',
  green: 'text-[#04B84C]',
  orange: 'text-[#FB6A22]',
}

const TASK_SUGGESTION_CATEGORIES: TaskSuggestionCategory[] = [
  {
    id: 'explore',
    labelKey: 'workbench.task_suggestions.explore.label',
    fallbackLabel: '探索并理解代码',
    tone: 'blue',
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
    tone: 'purple',
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
    tone: 'green',
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
    tone: 'orange',
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
      className="flex min-h-0 min-w-0 flex-1 flex-col px-6 pb-2 pt-8"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center pb-8">
        <div className="mx-auto flex w-[min(46rem,calc(100%_-_2rem))] min-w-0 flex-col items-center">
          <Bot className="mb-5 h-9 w-9 text-text-muted/55" aria-hidden="true" />
          <h1 className="mb-9 max-w-full text-center text-xl font-normal leading-9 tracking-normal text-text-primary/95">
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
            <div className="w-full" data-testid="task-suggestion-list">
              <button
                type="button"
                data-testid="task-suggestions-back-button"
                onClick={() => setSelectedCategoryId(null)}
                className="mb-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium leading-[18px] text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('workbench.task_suggestions.back', '返回全部建议')}
              </button>
              <div className="grid grid-cols-2 gap-2">
                {selectedCategory.suggestions.map(suggestion => (
                  <button
                    key={suggestion.id}
                    type="button"
                    data-testid={`task-suggestion-${selectedCategory.id}-${suggestion.id}`}
                    onClick={() =>
                      selectSuggestion(t(suggestion.promptKey, suggestion.fallbackPrompt))
                    }
                    className="flex min-h-11 items-center rounded-xl border border-border/70 bg-background/50 px-4 text-left text-sm font-medium leading-[18px] text-text-secondary transition-[background-color,color,transform] hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-[0.99]"
                  >
                    {t(suggestion.labelKey, suggestion.fallbackLabel)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.suggestionContainer}>
              <div
                data-testid="task-suggestion-categories"
                className={cn(styles.suggestionGrid, 'gap-3')}
              >
                {TASK_SUGGESTION_CATEGORIES.map(category => {
                  const Icon = CATEGORY_ICONS[category.tone]
                  return (
                    <button
                      key={category.id}
                      type="button"
                      data-testid={`task-suggestion-category-${category.id}`}
                      onClick={() => setSelectedCategoryId(category.id)}
                      className="group flex min-h-[104px] flex-col justify-between rounded-2xl border-0 bg-background px-4 py-3 text-left shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08)] ring-[0.5px] ring-black/10 transition-[background-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#339CFF] active:scale-[0.99] dark:ring-white/10"
                    >
                      <Icon className={cn('h-4 w-4', CATEGORY_TONES[category.tone])} />
                      <span className="text-sm font-medium leading-5 text-text-primary">
                        {t(category.labelKey, category.fallbackLabel)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        data-testid="desktop-empty-composer-dock"
        className="mx-auto w-[min(46rem,calc(100%_-_2rem))] min-w-0 shrink-0"
      >
        {composer}
      </div>
    </section>
  )
}
