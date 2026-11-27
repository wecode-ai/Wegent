import { roleSelectsProject, standInRoleName, type StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInIcon, type CollaborationProject } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowLeft, Check, Inbox, Plus, UserRound } from 'lucide-react'
import type { ComponentProps } from 'react'

export function StandInNavigationButton({
  selected,
  ...props
}: ComponentProps<typeof ControlButton> & { selected: boolean }) {
  return (
    <ControlButton
      variant="unstyled"
      type="button"
      className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:min-h-8 ${selected ? 'bg-text-primary font-medium text-background' : 'text-text-secondary hover:bg-muted'}`}
      {...props}
    />
  )
}

export function StandInMessageCenterButton({
  selected,
  onOpen,
}: {
  selected: boolean
  onOpen(): void
}) {
  const { t } = useTranslation('standInMessageCenter')
  return (
    <StandInNavigationButton
      selected={selected}
      data-testid="stand-in-message-center-open"
      aria-current={selected ? 'page' : undefined}
      onClick={onOpen}
    >
      <Inbox aria-hidden="true" className="size-4" />
      {t('center')}
    </StandInNavigationButton>
  )
}

function StandInConversationHeading({ name, onBack }: { name: string; onBack(): void }) {
  const { t } = useTranslation('common')
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <StandInNavigationButton
        selected={false}
        data-testid="stand-in-back-to-assistants"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        {t('standIn.title')}
      </StandInNavigationButton>
      <h2 data-testid="stand-in-role-help" className="min-w-0 truncate font-medium">
        {name}
      </h2>
    </div>
  )
}

export function StandInNavigation({
  conversationName,
  messageCenter,
  ...roles
}: ComponentProps<typeof StandInRoleSelector> & {
  conversationName?: string
  messageCenter?: { selected: boolean; onOpen(): void }
}) {
  return conversationName === undefined ? (
    <StandInRoleSelector {...roles} messageCenter={messageCenter} />
  ) : (
    <StandInConversationHeading name={conversationName} onBack={() => roles.chooseRole()} />
  )
}

function StandInRoleSelector({
  roles,
  projects,
  roleId,
  deviceId,
  retiredRoles,
  matchDevice,
  chooseRole,
  onCreate,
  messageCenter,
}: {
  roles: StandInRole[]
  projects: CollaborationProject[]
  roleId?: string
  deviceId?: string
  retiredRoles: ReadonlySet<string>
  matchDevice: boolean
  chooseRole(id?: string, device?: string): void
  onCreate(trigger: HTMLElement): void
  messageCenter?: { selected: boolean; onOpen(): void }
}) {
  const { t } = useTranslation('common')
  return (
    <nav
      className="min-w-0 flex-1 overflow-x-auto"
      aria-label={t('standIn.workspace.switch_role')}
      data-testid="stand-in-role-selector"
    >
      <div className="flex w-max items-center gap-1" data-testid="stand-in-overview-status">
        {messageCenter && <StandInMessageCenterButton {...messageCenter} />}
        <StandInNavigationButton
          selected={!roleId && !messageCenter?.selected}
          data-testid="stand-in-primary-open"
          aria-current={!roleId && !messageCenter?.selected ? 'page' : undefined}
          onClick={() => chooseRole()}
        >
          <UserRound aria-hidden="true" className="h-4 w-4" />
          {t('standIn.personal.default_role')}
          {!roleId && !messageCenter?.selected && (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </StandInNavigationButton>
        {roles.map((value, index) => {
          const selectedProjects = projects.filter(project =>
            roleSelectsProject(value, {
              id: project.id,
              store: project.project_store === 'local' ? 'local' : 'cloud',
            })
          )
          const scope = [
            ...selectedProjects.map(project => project.name),
            ...(value.connections ?? []).map(source => source.name),
          ].join(' · ')
          const selected =
            roleId === value.id && (!matchDevice || value.executionDeviceId === deviceId)
          return (
            <StandInNavigationButton
              selected={selected}
              key={`${value.migrationSource ?? value.executionDeviceId}:${value.id}`}
              data-testid={`stand-in-overview-role-${value.id}${roles.filter(role => role.id === value.id).length > 1 ? `-${value.executionDeviceId}` : ''}`}
              aria-current={selected ? 'page' : undefined}
              title={
                scope ||
                t(value.enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')
              }
              onClick={() => chooseRole(value.id, value.executionDeviceId)}
            >
              <StandInIcon
                enabled={value.enabled}
                className={`h-4 w-4 ${selected ? '[&_g]:text-background' : ''}`}
              />
              <span className="max-w-40 truncate">
                {standInRoleName(value, index, t('standIn.personal.unnamed_assistant'))}
                {retiredRoles.has(value.id) ? ` · ${t('standIn.account.device_only')}` : ''}
              </span>
              {selected && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
              <span className="sr-only">{scope}</span>
              <span className="sr-only">
                {t(value.enabled ? 'standIn.auto_on' : 'standIn.auto_off')}
                {t('standIn.personal.connected_selected', { count: selectedProjects.length })}
              </span>
            </StandInNavigationButton>
          )
        })}
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="stand-in-create-role"
          onClick={event => onCreate(event.currentTarget)}
          className="flex h-11 shrink-0 items-center gap-1 rounded-md px-2 text-text-secondary hover:bg-muted md:h-8"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t('standIn.personal.create_title')}
        </ControlButton>
      </div>
    </nav>
  )
}
