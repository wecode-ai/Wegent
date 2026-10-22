import { useState } from 'react'
import { Plus } from 'lucide-react'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { ComposerCatalogContext } from '@/components/chat/composer/ComposerCatalogContext'
import { useRuntimeComposerCatalog } from '@/components/chat/composer/useRuntimeComposerCatalog'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInRequirements({
  role,
  services,
  onChange,
  disabled,
  onSave,
}: {
  role: StandInRole
  services: WorkbenchServices
  onChange(update: (current: StandInRole) => StandInRole): void
  disabled: boolean
  onSave(): void
}) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const catalog = useRuntimeComposerCatalog(
    expanded
      ? {
          deviceId: role.executionDeviceId,
          scope: 'workspace',
          workspacePath: role.workspace?.workspacePath ?? null,
        }
      : null,
    services,
    t
  )
  return expanded ? (
    <ComposerCatalogContext.Provider value={catalog}>
      <BufferedChatInput
        value={role.prompt}
        onChange={prompt => onChange(current => ({ ...current, prompt }))}
        onDraftEdit={prompt => onChange(current => ({ ...current, prompt }))}
        onSubmit={() => onSave()}
        disabled={disabled}
        clearOnSubmit={false}
        allowEmptySubmit
        inputTestId="stand-in-prompt"
        variant="desktop"
        presentation="configuration"
        placeholder={t('standIn.personal.requirements_placeholder')}
        showProjectWorkBar={false}
        showWorkspaceMenu={false}
        showExecutionTools={false}
        onSetGoal={() => onChange(current => ({ ...current, goalMode: true }))}
        goalDraftActive={Boolean(role.goalMode)}
        onCancelGoalDraft={() => onChange(current => ({ ...current, goalMode: false }))}
      />
    </ComposerCatalogContext.Provider>
  ) : (
    <button
      type="button"
      data-testid="stand-in-requirements-open"
      disabled={disabled}
      onClick={() => setExpanded(true)}
      className="flex min-h-9 max-w-full items-center gap-2 text-left text-sm text-text-secondary hover:text-text-primary"
    >
      <Plus className="h-4 w-4 shrink-0" />
      <span className="truncate">{role.prompt || t('standIn.personal.requirements')}</span>
    </button>
  )
}
