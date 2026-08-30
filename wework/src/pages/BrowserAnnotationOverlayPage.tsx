import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import {
  closeEmbeddedBrowserAnnotationDraft,
  deleteEmbeddedBrowserAnnotationDraft,
  listenEmbeddedBrowserAnnotationOverlayState,
  readEmbeddedBrowserAnnotationOverlayState,
  resizeEmbeddedBrowserAnnotationOverlay,
  saveEmbeddedBrowserAnnotationDraft,
} from '@/lib/embedded-browser'
import type {
  BrowserAdjustmentProperty,
  BrowserAnnotationOverlayState,
  BrowserDesignChange,
} from '@/types/browser-annotation'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const EMPTY_STATE: BrowserAnnotationOverlayState = { open: false, draft: null }
const COMMENT_OVERLAY_SIZE = { width: 326, height: 220 }
const DESIGN_OVERLAY_SIZE = { width: 376, height: 540 }

const DESIGN_GROUPS: Array<{
  labelKey:
    | 'workbench.browser_annotation_design_group_text'
    | 'workbench.browser_annotation_design_group_appearance'
    | 'workbench.browser_annotation_design_group_layout'
  properties: BrowserAdjustmentProperty[]
}> = [
  {
    labelKey: 'workbench.browser_annotation_design_group_text',
    properties: ['color', 'font-family', 'font-size', 'font-weight'],
  },
  {
    labelKey: 'workbench.browser_annotation_design_group_appearance',
    properties: ['background-color', 'opacity', 'border-radius', 'border-color', 'border-width'],
  },
  {
    labelKey: 'workbench.browser_annotation_design_group_layout',
    properties: ['width', 'height', 'padding', 'margin'],
  },
]

type DesignValues = Partial<Record<BrowserAdjustmentProperty, string>>

export function BrowserAnnotationOverlayPage() {
  const [state, setState] = useState(EMPTY_STATE)

  useEffect(() => {
    void readEmbeddedBrowserAnnotationOverlayState().then(setState)
    const listener = listenEmbeddedBrowserAnnotationOverlayState(setState)
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener.then(next => {
      if (disposed) next()
      else unlisten = next
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const draft = state.draft
  if (!state.open || !draft) {
    return <main className="h-screen bg-transparent" data-testid="browser-annotation-overlay" />
  }

  return (
    <BrowserAnnotationEditor
      key={`${draft.commentId ?? 'new'}:${draft.anchor.selector}`}
      draft={draft}
    />
  )
}

function BrowserAnnotationEditor({
  draft,
}: {
  draft: NonNullable<BrowserAnnotationOverlayState['draft']>
}) {
  const { t } = useTranslation()
  const [comment, setComment] = useState(draft.comment)
  const [designValues, setDesignValues] = useState<DesignValues>(
    () =>
      Object.fromEntries(
        draft.designChanges.map(change => [change.property, change.value])
      ) as DesignValues
  )
  const [designOpen, setDesignOpen] = useState(draft.designChanges.length > 0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const size = designOpen ? DESIGN_OVERLAY_SIZE : COMMENT_OVERLAY_SIZE
    void resizeEmbeddedBrowserAnnotationOverlay(size)
  }, [designOpen])

  const designChanges = useMemo<BrowserDesignChange[]>(
    () =>
      (Object.entries(designValues) as Array<[BrowserAdjustmentProperty, string]>).flatMap(
        ([property, rawValue]) => {
          const value = rawValue?.trim()
          if (!value) return []
          const previous = draft.designChanges.find(change => change.property === property)
          return [
            {
              property,
              value,
              previousValue: previous?.previousValue ?? draft.designValues[property] ?? '',
            },
          ]
        }
      ),
    [designValues, draft.designChanges, draft.designValues]
  )

  const canSubmit = comment.trim().length > 0 || designChanges.length > 0
  const targetLabel = annotationTargetLabel(draft.anchor)
  const displayedDesignValues = useMemo(
    () =>
      ({
        ...Object.fromEntries(
          Object.entries(draft.designValues).map(([property, value]) => [
            property,
            designInputValue(property as BrowserAdjustmentProperty, value),
          ])
        ),
        ...designValues,
      }) as DesignValues,
    [designValues, draft.designValues]
  )

  const submit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setSubmitError('')
    try {
      await saveEmbeddedBrowserAnnotationDraft({
        comment,
        designChanges,
        textChange: draft.textChange,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSubmitError(message)
      console.error('[browser-annotation] failed to save draft', error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main
      className="flex h-screen items-start justify-center bg-transparent p-2 text-text-primary"
      data-testid="browser-annotation-overlay"
      onKeyDown={event => {
        if (event.key === 'Escape') void closeEmbeddedBrowserAnnotationDraft()
      }}
    >
      <form
        className={cn(
          'relative flex max-h-full w-full flex-col overflow-hidden rounded-[22px]',
          'border border-border/70 bg-popover shadow-xl',
          designOpen ? 'max-w-[344px]' : 'max-w-[294px]'
        )}
        data-testid="browser-annotation-editor-surface"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <button
          type="button"
          aria-label={t('workbench.browser_annotation_adjust')}
          title={t('workbench.browser_annotation_adjust')}
          data-testid="browser-annotation-design-button"
          className={cn(
            'absolute left-3 top-2 z-10 flex size-7 items-center justify-center rounded-lg',
            'text-text-secondary outline-none hover:bg-surface-secondary',
            'focus-visible:ring-1 focus-visible:ring-focus',
            designOpen && 'bg-surface-secondary text-text-primary'
          )}
          onClick={() => setDesignOpen(current => !current)}
        >
          <SlidersHorizontal className="size-4" />
        </button>

        <div className="min-w-0 px-3 pb-1 pt-3 pl-12">
          <div
            aria-label={t('workbench.browser_annotation_selected_items')}
            className="flex min-w-0 overflow-x-auto pb-1"
            data-testid="browser-annotation-selected-items"
            role="list"
          >
            <span
              className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded-lg border border-border bg-surface-secondary/50 py-0.5 pl-1 pr-0.5 text-xs"
              data-testid="browser-annotation-selection-chip"
              role="listitem"
              title={targetLabel}
            >
              <span className="shrink-0 rounded-md border border-border bg-background/60 px-1.5 py-px font-mono text-xs text-text-secondary">
                {draft.anchor.tagName.toLowerCase()}
              </span>
              <span className="min-w-0 truncate text-text-secondary">{targetLabel}</span>
              <button
                type="button"
                aria-label={t('workbench.browser_annotation_remove_selection', {
                  label: targetLabel,
                })}
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-text-tertiary outline-none hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-focus"
                onClick={() => void closeEmbeddedBrowserAnnotationDraft()}
              >
                <X className="size-3.5" />
              </button>
            </span>
          </div>
        </div>

        {designOpen ? (
          <DesignEditor
            changedValues={designValues}
            values={displayedDesignValues}
            onChange={(property, value) =>
              setDesignValues(current => ({ ...current, [property]: value }))
            }
            onReset={property =>
              setDesignValues(current => {
                const next = { ...current }
                delete next[property]
                return next
              })
            }
          />
        ) : null}

        <div className={cn('min-h-0 px-4', designOpen ? 'pt-2' : 'pt-1')}>
          <textarea
            ref={inputRef}
            aria-label={t('workbench.browser_annotation_placeholder')}
            data-testid="browser-annotation-comment-input"
            className={cn(
              'text-chat w-full resize-none border-0 bg-transparent text-text-primary outline-none',
              'placeholder:text-text-tertiary',
              designOpen ? 'h-14' : 'h-20'
            )}
            placeholder={t(
              designOpen
                ? 'workbench.browser_annotation_tweaks_placeholder'
                : 'workbench.browser_annotation_placeholder'
            )}
            value={comment}
            onChange={event => setComment(event.target.value)}
            onKeyDown={event => {
              if (
                event.key === 'Enter' &&
                !event.altKey &&
                !event.shiftKey &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </div>

        {submitError ? (
          <p
            role="alert"
            data-testid="browser-annotation-submit-error"
            className="px-4 pb-2 text-xs text-status-error"
          >
            {submitError}
          </p>
        ) : null}

        <div
          className={cn(
            'flex h-12 shrink-0 items-center border-t border-border/60 px-3',
            draft.commentId ? 'justify-between' : 'justify-end'
          )}
          data-testid="browser-annotation-footer-actions"
        >
          {draft.commentId ? (
            <button
              type="button"
              aria-label={t('workbench.browser_annotation_delete')}
              title={t('workbench.browser_annotation_delete')}
              data-testid="browser-annotation-delete-button"
              className="flex size-7 items-center justify-center rounded-lg text-text-tertiary outline-none hover:bg-surface-secondary hover:text-status-error focus-visible:ring-1 focus-visible:ring-focus"
              onClick={() => void deleteEmbeddedBrowserAnnotationDraft()}
            >
              <Trash2 className="size-4" />
            </button>
          ) : null}

          <div className="flex items-center gap-1.5">
            {draft.commentId || designOpen ? (
              <button
                type="button"
                className="h-7 rounded-lg border border-border px-3 text-sm text-text-primary outline-none hover:bg-surface-secondary focus-visible:ring-1 focus-visible:ring-focus"
                onClick={() => void closeEmbeddedBrowserAnnotationDraft()}
              >
                {t('workbench.cancel')}
              </button>
            ) : null}
            <button
              type="submit"
              aria-label={
                draft.commentId
                  ? t('workbench.browser_annotation_save')
                  : t('workbench.browser_annotation_add')
              }
              title={
                draft.commentId
                  ? t('workbench.browser_annotation_save')
                  : t('workbench.browser_annotation_add')
              }
              data-testid="browser-annotation-submit-button"
              className={cn(
                'flex h-7 items-center justify-center rounded-lg bg-text-primary text-background outline-none',
                draft.commentId || designOpen ? 'min-w-14 px-3 text-sm' : 'w-7',
                'disabled:cursor-not-allowed disabled:opacity-35 focus-visible:ring-2 focus-visible:ring-focus'
              )}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : draft.commentId ? (
                t('workbench.browser_annotation_save')
              ) : designOpen ? (
                t('workbench.browser_annotation_add')
              ) : (
                <ArrowUp className="size-4" />
              )}
            </button>
          </div>
        </div>

        <span
          className="sr-only"
          data-testid={
            draft.screenshotState === 'ready'
              ? 'browser-annotation-screenshot-ready'
              : 'browser-annotation-screenshot-state'
          }
        >
          {draft.screenshotState}
        </span>
      </form>
    </main>
  )
}

function DesignEditor({
  changedValues,
  values,
  onChange,
  onReset,
}: {
  changedValues: DesignValues
  values: DesignValues
  onChange: (property: BrowserAdjustmentProperty, value: string) => void
  onReset: (property: BrowserAdjustmentProperty) => void
}) {
  const { t } = useTranslation()

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-4 py-2"
      data-testid="browser-annotation-design-editor"
    >
      {DESIGN_GROUPS.map(group => (
        <details
          className="group border-b border-border/50 last:border-b-0"
          key={group.labelKey}
          open
        >
          <summary className="flex h-8 cursor-default list-none items-center justify-between text-sm text-text-secondary">
            <span>{t(group.labelKey)}</span>
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-1 pb-2">
            {group.properties.map(property => {
              const label = t(`workbench.browser_annotation_adjustment_${property}`)
              const value = values[property] ?? ''
              return (
                <label
                  className="grid min-h-8 grid-cols-[minmax(0,1fr)_140px_28px] items-center gap-2 text-sm"
                  key={property}
                >
                  <span className="truncate text-text-secondary">{label}</span>
                  <input
                    aria-label={label}
                    data-browser-sidebar-design-content-input="true"
                    data-testid={
                      property === 'color'
                        ? 'browser-annotation-design-color'
                        : `browser-annotation-design-${property}`
                    }
                    className="h-7 min-w-0 rounded-lg border border-border bg-background px-2 font-mono text-xs text-text-primary outline-none focus:border-focus"
                    placeholder={designPlaceholder(property)}
                    value={value}
                    onChange={event => onChange(property, event.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={t('workbench.browser_annotation_reset_property', {
                      property: label,
                    })}
                    title={t('workbench.browser_annotation_reset_property', {
                      property: label,
                    })}
                    className="flex size-7 items-center justify-center rounded-lg text-text-tertiary outline-none hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-focus disabled:opacity-25"
                    disabled={changedValues[property] === undefined}
                    onClick={() => onReset(property)}
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                </label>
              )
            })}
          </div>
        </details>
      ))}
    </div>
  )
}

function annotationTargetLabel(
  anchor: NonNullable<BrowserAnnotationOverlayState['draft']>['anchor']
): string {
  return (
    anchor.immediateText?.trim() ||
    anchor.name?.trim() ||
    anchor.title?.trim() ||
    anchor.role?.trim() ||
    anchor.selector
  )
}

function designPlaceholder(property: BrowserAdjustmentProperty): string {
  switch (property) {
    case 'color':
    case 'background-color':
    case 'border-color':
      return '#000000'
    case 'opacity':
      return '1'
    case 'font-family':
      return 'system-ui'
    case 'font-weight':
      return '400'
    default:
      return '0px'
  }
}

function designInputValue(property: BrowserAdjustmentProperty, value: string): string {
  if (!['color', 'background-color', 'border-color'].includes(property)) return value
  const match = value.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i
  )
  if (!match || (match[4] !== undefined && Number(match[4]) !== 1)) return value
  return `#${match
    .slice(1, 4)
    .map(component =>
      Math.round(Math.min(255, Math.max(0, Number(component))))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}
