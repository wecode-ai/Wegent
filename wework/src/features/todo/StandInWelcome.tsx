import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import {
  ArrowRightLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronRight,
  ClipboardList,
  Code2,
  FileCheck,
  FolderOpen,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  Reply,
  Route,
  ScrollText,
  X,
} from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { StandInWelcomeShape } from './standInWelcomeMotion'

const featuredExamples = [
  { id: 'dingtalk_reply', icon: MessageSquare, shape: 'connection' },
  { id: 'development', icon: Code2, shape: 'orbit' },
  { id: 'daily_check', icon: CalendarDays, shape: 'agenda' },
  { id: 'knowledge', icon: FolderOpen, shape: 'list' },
  { id: 'weekly_review', icon: ScrollText, shape: 'agenda' },
] as const

const exampleGroups = {
  daily: [
    { id: 'brief', icon: ListTodo, shape: 'list' },
    { id: 'project', icon: Route, shape: 'orbit' },
    { id: 'weekly', icon: ScrollText, shape: 'list' },
  ],
  meetings: [
    { id: 'meeting_prep', icon: CalendarDays, shape: 'agenda' },
    { id: 'recap', icon: ClipboardList, shape: 'list' },
    { id: 'handoff', icon: ArrowRightLeft, shape: 'connection' },
  ],
  decisions: [
    { id: 'launch', icon: FileCheck, shape: 'agenda' },
    { id: 'reply', icon: Reply, shape: 'connection' },
    { id: 'decision', icon: CheckSquare, shape: 'agenda' },
  ],
} as const

const examples = [...featuredExamples, ...Object.values(exampleGroups).flat()]
type Example = (typeof examples)[number]

function StandInTemplateLibrary({
  close,
  onSelect,
}: {
  close(): void
  onSelect(example: Example): void
}) {
  const { t } = useTranslation('common')
  return (
    <DialogSurface
      inline={false}
      onClose={close}
      render={
        <div
          aria-labelledby="stand-in-template-library-title"
          data-testid="stand-in-template-library"
          className="w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl"
        />
      }
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 id="stand-in-template-library-title" className="text-base font-semibold">
          {t('standIn.welcome.more_templates')}
        </h2>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('standIn.close')}
          data-testid="stand-in-template-library-close"
          className="min-h-11 min-w-11"
          onClick={close}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {Object.entries(exampleGroups).map(([category, group]) => (
        <section key={category} className="mt-4 space-y-1">
          <h3 className="px-2 text-sm font-medium text-text-secondary">
            {t(`standIn.welcome.template_categories.${category}`)}
          </h3>
          {group.map(example => (
            <Button
              key={example.id}
              type="button"
              variant="ghost"
              data-testid={`stand-in-template-library-${example.id}`}
              className="h-auto min-h-11 w-full justify-start px-2 py-2 text-left whitespace-normal"
              onClick={() => {
                close()
                onSelect(example)
              }}
            >
              <example.icon aria-hidden="true" className="size-4" />
              {t(`standIn.welcome.examples.${example.id}.title`)}
              <ChevronRight aria-hidden="true" className="ml-auto size-4 text-text-secondary" />
            </Button>
          ))}
        </section>
      ))}
    </DialogSurface>
  )
}

export interface StandInStarterRequest {
  prompt?: string
  intent?: 'create'
}

export function StandInConversationTemplates({ onSelect }: { onSelect(prompt: string): void }) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const applyTemplate = ({ id }: Example) => {
    onSelect(t(`standIn.welcome.examples.${id}.prompt`))
    setExpanded(false)
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        data-testid="stand-in-chat-templates"
        className="min-h-11 md:min-h-8"
        onClick={() => setExpanded(!expanded)}
      >
        {t('standIn.welcome.templates')}
      </Button>
      {expanded && (
        <>
          {featuredExamples.map(example => (
            <Button
              key={example.id}
              type="button"
              size="sm"
              variant="outline"
              data-testid={`stand-in-chat-template-${example.id}`}
              className="min-h-11 md:min-h-8"
              onClick={() => applyTemplate(example)}
            >
              {t(`standIn.welcome.examples.${example.id}.title`)}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="stand-in-chat-more-templates"
            className="min-h-11 md:min-h-8"
            aria-haspopup="dialog"
            onClick={() => setLibraryOpen(true)}
          >
            {t('standIn.welcome.more_templates')}
          </Button>
        </>
      )}
      {libraryOpen && (
        <StandInTemplateLibrary close={() => setLibraryOpen(false)} onSelect={applyTemplate} />
      )}
    </div>
  )
}

export function StandInWelcome({
  active,
  busy,
  error,
  selectedPrompt,
  onStart,
  onAdvanced,
}: {
  active: boolean
  busy: boolean
  error?: string
  selectedPrompt?: string
  onStart(prompt?: string): void
  onAdvanced(): void
}) {
  const { t } = useTranslation('common')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [selected, setSelected] = useState<Example | undefined>(() =>
    selectedPrompt
      ? examples.find(({ id }) => t(`standIn.welcome.examples.${id}.prompt`) === selectedPrompt)
      : undefined
  )
  const motion = useRef<{ shape: StandInWelcomeShape; redraw?: () => void }>({
    shape: selected?.shape ?? 'idle',
  })
  const canvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !active) return
      let mounted = true
      let dispose: (() => void) | undefined
      void import('./standInWelcomeMotion').then(({ animateStandInWelcome }) => {
        if (!mounted) return
        const animation = animateStandInWelcome(canvas, () => motion.current.shape)
        canvas.hidden = !animation
        motion.current.redraw = animation?.redraw
        dispose = animation?.dispose
      })
      return () => {
        mounted = false
        motion.current.redraw = undefined
        dispose?.()
      }
    },
    [active]
  )
  const selectExample = (example: Example | undefined) => {
    motion.current.shape = example?.shape ?? 'idle'
    motion.current.redraw?.()
    setSelected(example)
  }
  const key = selected && `standIn.welcome.examples.${selected.id}`
  return (
    <section
      className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 pt-[clamp(1.25rem,5dvh,3.5rem)] pb-8"
      data-testid="stand-in-welcome"
    >
      <div className="w-full max-w-4xl text-center">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="mx-auto aspect-[2/1] max-h-[min(42dvh,30rem)] w-full"
        />
        <h1 className="heading-lg text-balance">{t('standIn.welcome.title')}</h1>
        <div className="mx-auto mt-6 max-w-[42rem] rounded-3xl border border-border bg-background p-2.5 text-left shadow-sm sm:p-3">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-1.5">
            {featuredExamples.map(example => {
              const isSelected = selected?.id === example.id
              const Indicator = isSelected ? Check : ArrowUpRight
              const copy = `standIn.welcome.examples.${example.id}`
              return (
                <Button
                  key={example.id}
                  type="button"
                  variant="ghost"
                  aria-pressed={isSelected}
                  data-testid={`stand-in-welcome-example-${example.id}`}
                  className="group h-auto min-h-14 w-full justify-start gap-3 rounded-2xl px-2.5 py-2.5 text-left whitespace-normal hover:bg-muted focus-visible:ring-2 aria-pressed:bg-focus/10"
                  onClick={() => selectExample(isSelected ? undefined : example)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-text-secondary group-aria-pressed:bg-focus/15 group-aria-pressed:text-focus">
                    <example.icon aria-hidden="true" className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium text-text-primary">{t(`${copy}.title`)}</span>
                    <span className="text-xs font-normal text-text-secondary">
                      {t(`${copy}.hint`)}
                    </span>
                  </span>
                  <Indicator
                    aria-hidden="true"
                    className="size-4 shrink-0 text-text-secondary group-aria-pressed:text-focus"
                  />
                </Button>
              )
            })}
            <Button
              type="button"
              variant="ghost"
              aria-haspopup="dialog"
              data-testid="stand-in-welcome-more"
              className="h-auto min-h-14 w-full justify-start gap-3 rounded-2xl px-2.5 py-2.5 text-left whitespace-normal text-text-secondary hover:bg-muted focus-visible:ring-2"
              onClick={() => setLibraryOpen(true)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                <LayoutGrid aria-hidden="true" className="size-4" />
              </span>
              {t('standIn.welcome.more_templates')}
              <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0" />
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-2 px-2 text-sm text-error">
              {error}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5 border-t border-border px-1 pt-2">
            <Button
              type="button"
              data-testid="stand-in-welcome-start"
              disabled={busy}
              aria-busy={busy}
              className="min-h-11 rounded-full px-4 md:min-h-8"
              onClick={() => onStart(key ? t(`${key}.prompt`) : undefined)}
            >
              {t(
                busy ? 'standIn.loading' : key ? 'standIn.welcome.try' : 'standIn.onboarding.start'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-testid="stand-in-welcome-advanced"
              disabled={busy}
              className="ml-auto min-h-11 text-text-secondary md:min-h-8"
              onClick={onAdvanced}
            >
              {t('standIn.welcome.advanced')}
            </Button>
          </div>
          {key && (
            <div
              data-testid="stand-in-welcome-preview"
              className="mt-4 mb-1 border-l-2 border-focus/40 py-2 pr-2 pl-3.5 sm:ml-2"
            >
              <p className="mb-1 text-xs font-semibold text-text-primary">{t(`${key}.title`)}</p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-text-secondary">
                {t(`${key}.prompt`)}
              </p>
            </div>
          )}
        </div>
        {libraryOpen && (
          <StandInTemplateLibrary close={() => setLibraryOpen(false)} onSelect={selectExample} />
        )}
      </div>
    </section>
  )
}
