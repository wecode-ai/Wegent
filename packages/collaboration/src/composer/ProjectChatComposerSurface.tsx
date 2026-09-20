import { useEffect, useRef, useState, type FormHTMLAttributes, type ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import styles from './ProjectChatComposer.module.css'

export const PROJECT_CHAT_EDITOR_CLASS = cn(
  'max-h-[112px] min-h-12 w-full resize-none overflow-y-auto bg-transparent px-0 pb-0 pt-1 text-chat text-text-primary outline-none placeholder:text-text-muted/55',
  styles.input
)
export const PROJECT_CHAT_TOOLBAR_CLASS = styles.toolbar
export const DOCUMENT_EDITOR_CLASS =
  'min-h-32 max-h-[60vh] w-full overflow-y-auto whitespace-pre-wrap bg-transparent py-2 text-chat text-text-primary outline-none placeholder:text-text-muted/55'

/** One PC composer surface; host adapters own draft and runtime effects. */
export function ProjectChatComposerSurface({
  workBar,
  children,
  formProps,
  canCollapseInShortPane = false,
  collapseWhenIdle = false,
  isDraggingFiles = false,
  presentation = 'chat',
}: {
  workBar?: ReactNode
  children: ReactNode
  formProps: Omit<FormHTMLAttributes<HTMLFormElement>, 'className' | 'children'>
  canCollapseInShortPane?: boolean
  collapseWhenIdle?: boolean
  isDraggingFiles?: boolean
  presentation?: 'chat' | 'document'
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [shortComposerExpanded, setShortComposerExpanded] = useState(false)
  useEffect(() => {
    if (!shortComposerExpanded) return
    const outside = (event: MouseEvent) => {
      if (!formRef.current?.contains(event.target as Node)) setShortComposerExpanded(false)
    }
    window.addEventListener('click', outside, true)
    return () => window.removeEventListener('click', outside, true)
  }, [shortComposerExpanded])
  return (
    <div
      data-testid="project-chat-composer"
      data-presentation={presentation}
      className={
        presentation === 'document'
          ? 'relative w-full rounded-2xl border border-border/60 bg-background shadow-sm focus-within:border-focus/70 transition-colors'
          : 'relative w-full rounded-[26px] bg-surface shadow-[0_0_0_0.5px_rgba(13,13,13,0.12),0_3px_7.5px_rgba(0,0,0,0.04),0_0_20px_rgba(0,0,0,0.05)]'
      }
    >
      {workBar}
      <form
        {...formProps}
        onClickCapture={event => {
          setShortComposerExpanded(true)
          formProps.onClickCapture?.(event)
        }}
        onFocusCapture={event => {
          setShortComposerExpanded(true)
          formProps.onFocusCapture?.(event)
        }}
        ref={formRef}
        data-testid="project-chat-composer-form"
        data-short-collapse={presentation === 'chat' && canCollapseInShortPane ? 'true' : undefined}
        data-short-expanded={shortComposerExpanded ? 'true' : 'false'}
        className={cn(
          'relative z-10 flex w-full flex-col bg-background transition-colors',
          presentation === 'document'
            ? 'rounded-2xl px-5 pb-3 pt-1'
            : 'min-h-[76px] rounded-[26px] border px-4 pb-1.5 pt-2',
          presentation === 'chat' && styles.form,
          presentation === 'chat' && collapseWhenIdle && styles.collapseWhenIdle,
          isDraggingFiles ? 'border-focus ring-2 ring-focus/20' : 'border-border/45'
        )}
      >
        {children}
      </form>
    </div>
  )
}
