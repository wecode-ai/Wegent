import * as Popover from '@radix-ui/react-popover'
import { Settings } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'

export function ExperienceAccount({ name }: { name?: string }) {
  const { t } = useTranslation('collaborationExp')
  const theme = useCollaborationPortalTheme()
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="experience-account"
          aria-label={t('shell.account')}
          data-testid="collaboration-exp-account"
        >
          <span className="experience-account-avatar" aria-hidden="true">
            {name?.slice(0, 1) ?? '?'}
          </span>
          <span className="truncate">{name ?? t('shell.settings')}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...theme}
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className={`${theme.className} z-system-popover w-[180px] rounded-lg border border-border bg-popover p-1.5 text-text-primary shadow-lg`}
          data-testid="collaboration-exp-account-menu"
        >
          <Popover.Close asChild>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-muted md:min-h-9"
              data-testid="collaboration-exp-account-settings"
              onClick={() => navigateTo('/settings')}
            >
              <Settings size={16} aria-hidden="true" />
              {t('shell.settings')}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
