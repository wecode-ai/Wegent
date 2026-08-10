import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { isHttpUrl, openExternalUrl } from '@/lib/external-links'
import type { WeworkInstalledReleaseNotes } from './app-release-notes'

interface AppReleaseNotesDialogProps {
  open: boolean
  releaseNotes: WeworkInstalledReleaseNotes
  onClose: () => void
}

export function AppReleaseNotesDialog({ open, releaseNotes, onClose }: AppReleaseNotesDialogProps) {
  const { t } = useTranslation('common')
  useEscapeKey(onClose, open)

  if (!open) return null

  const closeLabel = t('workbench.app_release_notes_close', '关闭更新日志')

  return createPortal(
    <div
      data-testid="app-release-notes-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        data-testid="app-release-notes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-release-notes-dialog-title"
        className="relative flex max-h-[min(720px,calc(100dvh-32px))] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-text-primary shadow-2xl"
      >
        <button
          type="button"
          data-testid="app-release-notes-dialog-close"
          aria-label={closeLabel}
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-md bg-popover text-text-secondary hover:bg-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <article className="min-h-0 overflow-y-auto px-7 pb-8 pt-7">
          <div className="pr-10 text-sm font-medium text-text-muted">
            {t('workbench.app_release_notes_version', {
              defaultValue: '版本 {{version}}',
              version: releaseNotes.version,
            })}
          </div>
          <h2 id="app-release-notes-dialog-title" className="heading-lg mt-2 text-text-primary">
            {t('workbench.app_release_notes_title', 'Wework 更新日志')}
          </h2>
          <div
            data-testid="app-release-notes-content"
            className="mt-6 text-sm leading-6 text-text-secondary"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  const externalHref = isHttpUrl(href) ? href : undefined
                  return (
                    <a
                      href={externalHref}
                      className="font-medium text-blue-600 underline underline-offset-2 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
                      onClick={event => {
                        event.preventDefault()
                        if (externalHref) void openExternalUrl(externalHref)
                      }}
                    >
                      {children}
                    </a>
                  )
                },
                h1: ({ children }) => (
                  <h3 className="heading-sm mb-2 mt-6 first:mt-0">{children}</h3>
                ),
                h2: ({ children }) => (
                  <h3 className="heading-sm mb-2 mt-6 first:mt-0">{children}</h3>
                ),
                h3: ({ children }) => (
                  <h3 className="text-base font-medium text-text-primary">{children}</h3>
                ),
                p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
                ul: ({ children }) => (
                  <ul className="mb-4 list-disc space-y-2 pl-5 last:mb-0">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="mb-4 list-decimal space-y-2 pl-5 last:mb-0">{children}</ol>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-code text-text-primary">
                    {children}
                  </code>
                ),
              }}
            >
              {releaseNotes.body}
            </ReactMarkdown>
          </div>
        </article>
      </div>
    </div>,
    document.body
  )
}
