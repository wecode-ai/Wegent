import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import {
  ProjectExecutionEnvironments,
  createCollaborationTranslator,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { usePanelData } from '@wegent/collaboration/platform'
import { ChevronDown, Monitor } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

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
  const [side, setSide] = useState<'top' | 'bottom'>('top')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  useEscapeKey(() => setOpen(false), open, popoverRef)
  const load = useCallback(() => api.projects.get(projectId), [api, projectId])
  const { data: project, error: cause, refresh } = usePanelData(load, open)
  const translate = createCollaborationTranslator(i18n?.language === 'en' ? 'en' : 'zh-CN')
  return (
    <Popover
      modal
      open={open}
      onOpenChange={next => {
        if (next && triggerRef.current) {
          const bounds = triggerRef.current.getBoundingClientRect()
          // Loading content must not lock the growing device list into the smaller side.
          setSide(bounds.top >= window.innerHeight - bounds.bottom ? 'top' : 'bottom')
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            data-testid="issue-environment-picker-trigger"
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
          />
        }
      >
        <Monitor aria-hidden="true" className="h-4 w-4" />
        {t('issue_creation.configure_devices')}
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </PopoverTrigger>
      <>
        <PopoverContent
          ref={popoverRef}
          aria-label={t('issue_creation.project_device_settings')}
          align="start"
          side={side}
          sideOffset={6}
          collisionPadding={8}
          data-testid="issue-environment-picker"
          className="z-system-popover max-h-[var(--available-height)] w-[min(480px,calc(100vw-16px))] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-text-primary shadow-lg"
        >
          {cause ? (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              {t('issue_creation.project_devices_load_failed')}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="issue-environment-retry"
                className="ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md underline md:min-h-8"
                onClick={() => void refresh()}
              >
                {t('independentIssues.retry')}
              </ControlButton>
            </div>
          ) : project ? (
            <ProjectExecutionEnvironments
              api={api}
              project={project}
              presentation="devices"
              translate={translate}
            />
          ) : (
            <p role="status" className="text-sm text-text-secondary">
              {t('independentIssues.loading')}
            </p>
          )}
        </PopoverContent>
      </>
    </Popover>
  )
}
