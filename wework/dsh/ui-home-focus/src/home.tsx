import { Bot, FileText, ListChecks, PenLine, Search } from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface HomeProps {
  heading: ReactNode
  onSelectSuggestion: (prompt: string) => void
}

interface FocusSuggestion {
  id: string
  labelKey: string
  fallbackLabel: string
  promptKey: string
  fallbackPrompt: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  tone: string
}

const FOCUS_SUGGESTIONS: FocusSuggestion[] = [
  {
    id: 'research',
    labelKey: 'workbench.focus_suggestions.research.label',
    fallbackLabel: '整理和总结资料',
    promptKey: 'workbench.focus_suggestions.research.prompt',
    fallbackPrompt: '帮我整理并总结以下资料：',
    icon: Search,
    tone: 'text-[#0285FF]',
  },
  {
    id: 'writing',
    labelKey: 'workbench.focus_suggestions.writing.label',
    fallbackLabel: '撰写或润色内容',
    promptKey: 'workbench.focus_suggestions.writing.prompt',
    fallbackPrompt: '帮我撰写或润色以下内容：',
    icon: PenLine,
    tone: 'text-[#924FF7]',
  },
  {
    id: 'analysis',
    labelKey: 'workbench.focus_suggestions.analysis.label',
    fallbackLabel: '分析问题并给出建议',
    promptKey: 'workbench.focus_suggestions.analysis.prompt',
    fallbackPrompt: '帮我分析这个问题并给出可执行建议：',
    icon: FileText,
    tone: 'text-[#04B84C]',
  },
  {
    id: 'planning',
    labelKey: 'workbench.focus_suggestions.planning.label',
    fallbackLabel: '制定计划和拆解任务',
    promptKey: 'workbench.focus_suggestions.planning.prompt',
    fallbackPrompt: '帮我制定计划并拆解以下任务：',
    icon: ListChecks,
    tone: 'text-[#FB6A22]',
  },
]

export default function FocusHome({ heading, onSelectSuggestion }: HomeProps) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="focus-home"
      className="mx-auto flex w-[min(46rem,calc(100%_-_2rem))] min-w-0 flex-col items-center"
    >
      <Bot className="mb-5 h-9 w-9 text-text-muted/55" aria-hidden="true" />
      <div className="mb-2">{heading}</div>
      <p className="mb-8 text-center text-sm leading-5 text-text-muted">
        {t('workbench.focus_suggestions.description', '从一个常见任务开始，或直接描述你的目标')}
      </p>
      <div
        data-testid="focus-suggestions"
        className="grid w-full gap-3"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(10rem, 100%), 1fr))',
        }}
      >
        {FOCUS_SUGGESTIONS.map(suggestion => {
          const Icon = suggestion.icon
          return (
            <button
              key={suggestion.id}
              type="button"
              data-testid={`focus-suggestion-${suggestion.id}`}
              onClick={() => onSelectSuggestion(t(suggestion.promptKey, suggestion.fallbackPrompt))}
              className="group flex min-h-[104px] flex-col justify-between rounded-2xl border-0 bg-background px-4 py-3 text-left shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08)] ring-[0.5px] ring-black/10 transition-[background-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#339CFF] active:scale-[0.99] dark:ring-white/10"
            >
              <Icon className={`h-4 w-4 ${suggestion.tone}`} aria-hidden="true" />
              <span className="text-sm font-medium leading-5 text-text-primary">
                {t(suggestion.labelKey, suggestion.fallbackLabel)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
