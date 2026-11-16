import { useCallback, useState } from 'react'
import { usePanelData } from '@wegent/collaboration/platform'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, Monitor } from 'lucide-react'
import {
  ProjectExecutionEnvironments,
  createCollaborationTranslator,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'

/** Reuse project grants without navigating away from the Issue draft. */
export function IssueProjectEnvironmentPicker({
  api,
  projectId,
  disabled,
}: {
  api: SharedWorkspaceApi
  projectId: string
  disabled: boolean
}) {
  const { t, i18n } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const load = useCallback(() => api.projects.get(projectId), [api, projectId])
  const { data: project, error: cause, refresh } = usePanelData(load, open)
  const error = cause instanceof Error ? cause.message : cause ? String(cause) : ''
  const translate = createCollaborationTranslator(i18n?.language === 'en' ? 'en' : 'zh-CN')
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="issue-environment-picker-trigger"
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
        >
          <Monitor aria-hidden="true" className="h-4 w-4" />
          {t('issue_creation.configure_devices')}
          <ChevronDown aria-hidden="true" className="h-4 w-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-testid="issue-environment-picker"
          className="z-system-popover max-h-[var(--radix-popover-content-available-height)] w-[min(480px,calc(100vw-16px))] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-text-primary shadow-lg"
        >
          {error ? (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              {error}
              <button
                type="button"
                data-testid="issue-environment-retry"
                className="ml-2 underline"
                onClick={() => void refresh()}
              >
                {t('independentIssues.retry')}
              </button>
            </div>
          ) : project ? (
            <ProjectExecutionEnvironments
              api={api}
              project={project}
              presentation="devices"
              translate={translate}
            />
          ) : (
            <p role="status" className="text-sm text-text-muted">
              {t('independentIssues.loading')}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
