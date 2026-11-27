import { roleIncludesProject, standInRoleName, type StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollaborationProject } from '@wegent/collaboration'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowUpRight, ChevronDown } from 'lucide-react'

/** Select a reusable stand-in for a project and summarize its instructions and intake state. */
export function StandInProjectSetup({
  project,
  roles,
  projectRoleId,
  saving,
  creating,
  onChoose,
  role,
  onOpenSettings,
}: {
  project: CollaborationProject
  roles: StandInRole[]
  projectRoleId: string
  saving: boolean
  creating: boolean
  onChoose(value: string): void
  role?: StandInRole
  onOpenSettings?(): void
}) {
  const { t } = useTranslation('common')
  const enabled =
    role?.enabled &&
    roleIncludesProject(role, {
      id: project.id,
      store: project.project_store === 'local' ? 'local' : 'cloud',
    })
  return (
    <div className="space-y-4" data-testid="stand-in-project-setup">
      <label className="block space-y-2">
        <span className="font-medium">{t('standIn.personal.use_stand_in')}</span>
        <div className="relative rounded-lg border border-border bg-muted/40 hover:bg-muted/60 keyboard:focus-within:ring-2 keyboard:focus-within:ring-focus">
          <SelectRoot
            value={normalizeSelectValue(creating ? '__new' : projectRoleId)}
            disabled={saving}
            onValueChange={selectedValue => {
              if (selectedValue === null) return
              onChoose(selectedValue)
            }}
          >
            <SelectTrigger
              appearance="plain"
              data-testid="stand-in-project-select"
              className="min-h-9 w-full cursor-pointer appearance-none pl-3 pr-10 text-base disabled:cursor-default"
            />
            <SelectContent>
              <SelectItem value="" disabled>
                {t('standIn.personal.choose_stand_in')}
              </SelectItem>
              {roles.map(row => (
                <SelectItem key={row.id} value={String(row.id)}>
                  {standInRoleName(
                    row,
                    roles.indexOf(row),
                    t('standIn.personal.unnamed_assistant')
                  )}
                </SelectItem>
              ))}
              <SelectItem value="__new">{t('standIn.personal.new_project_stand_in')}</SelectItem>
            </SelectContent>
          </SelectRoot>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary"
          />
        </div>
      </label>
      {!creating && projectRoleId && role && (
        <>
          <div className="py-1" data-testid="stand-in-project-summary">
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {role.prompt && (
                <>
                  <dt className="text-text-muted">{t('standIn.personal.requirements_summary')}</dt>
                  <dd className="whitespace-pre-wrap break-words">
                    {role.prompt || t('standIn.personal.no_requirements')}
                  </dd>
                </>
              )}
              <dt className="text-text-muted">{t('standIn.personal.automatic_summary')}</dt>
              <dd>{t(enabled ? 'standIn.auto_on' : 'standIn.auto_off')}</dd>
            </dl>
            {!enabled && (
              <p
                data-testid="stand-in-project-enable-help"
                className="mt-3 text-xs text-text-muted"
              >
                {t('standIn.personal.enable_and_use_help')}
              </p>
            )}
            {enabled && (
              <p className="mt-3 text-xs text-text-muted">
                {t('standIn.personal.disable_project_help')}
              </p>
            )}
          </div>
          {onOpenSettings && (
            <div className="text-xs text-text-muted">
              <ControlButton
                variant="unstyled"
                type="button"
                disabled={saving}
                data-testid="stand-in-personal-settings-link"
                onClick={onOpenSettings}
                className="inline-flex min-h-8 items-center gap-1 text-primary hover:underline"
              >
                {t('standIn.personal.open_personal_settings')}
                <ArrowUpRight className="h-3 w-3" />
              </ControlButton>
              <p>{t('standIn.personal.shared_settings_help')}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
