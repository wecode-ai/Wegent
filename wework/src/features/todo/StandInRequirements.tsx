import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { ComposerCatalogContext } from '@/components/chat/composer/ComposerCatalogContext'
import { useStandInComposerCatalog } from './useStandInComposerCatalog'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectKey } from '@/lib/runtime-project'
import type { RuntimeWorkListResponse } from '@/types/api'
import { standInProjectWorkspace } from './useStandInRuntimeWork'

export function StandInRequirements({
  role,
  referencedPrompt,
  onReferencedPromptChange,
  runtimeWork,
  services,
  onChange,
  disabled,
  onSave,
}: {
  referencedPrompt?: string
  onReferencedPromptChange?(prompt: string): void
  role: StandInRole
  runtimeWork?: RuntimeWorkListResponse | null
  services: WorkbenchServices
  onChange(update: (current: StandInRole) => StandInRole): void
  disabled: boolean
  onSave(): void
}) {
  const { t } = useTranslation('common')
  const project = runtimeWork?.projects.find(
    row => runtimeProjectKey(row.project) === role.workspace?.projectKey
  )
  const workspace = project && standInProjectWorkspace(project, role.executionDeviceId)
  const catalog = useStandInComposerCatalog(
    {
      deviceId: role.executionDeviceId,
      scope: 'workspace',
      workspacePath: workspace?.workspacePath ?? null,
    },
    services,
    t
  )
  const editPrompt =
    onReferencedPromptChange ?? ((prompt: string) => onChange(current => ({ ...current, prompt })))
  return (
    <ComposerCatalogContext.Provider value={catalog}>
      <BufferedChatInput
        value={referencedPrompt ?? role.prompt}
        onChange={editPrompt}
        onDraftEdit={editPrompt}
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
  )
}
