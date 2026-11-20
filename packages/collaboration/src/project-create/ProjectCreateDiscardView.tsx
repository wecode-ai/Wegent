import { Button as ControlButton } from '../markdown/Button'
import { ProjectCreateConfigurationView } from './ProjectCreateConfigurationView'
import type { ProjectCreateLabels } from './types'

export function ProjectCreateDiscardView({
  target,
  labels,
  onKeepEditing,
  onDiscard,
}: {
  target: 'project' | 'group'
  labels: ProjectCreateLabels
  onKeepEditing(): void
  onDiscard(): void
}) {
  return (
    <ProjectCreateConfigurationView
      testId="collaboration-project-create-discard"
      onBack={onKeepEditing}
      backLabel={labels.keepEditing}
      footer={
        <ControlButton
          variant="unstyled"
          type="button"
          className="collaboration-primary-button"
          data-testid="collaboration-project-create-discard-confirm"
          onClick={onDiscard}
        >
          {labels.discardDraft}
        </ControlButton>
      }
    >
      <p className="collaboration-project-create-discard-description">
        {target === 'project' ? labels.discardProjectDescription : labels.discardGroupDescription}
      </p>
    </ProjectCreateConfigurationView>
  )
}
