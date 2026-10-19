import { FolderOpen, FolderPlus, Plus, SquarePen } from 'lucide-react'
import { ActionMenu } from '../controls/ActionMenu'

interface ProjectCreationActionLabels {
  addProject: string
  blankProject: string
  addFolder: string
  importExistingProject: string
}

export function ProjectCreationAction({
  className,
  messages,
  onSelect,
  supportsLocalImport,
  testId,
}: {
  className: string
  messages: ProjectCreationActionLabels
  onSelect(mode: 'blank' | 'folder' | 'existing'): void
  supportsLocalImport: boolean
  testId: string
}) {
  const optionTestIds =
    testId === 'collaboration-workspace-project-create'
      ? {
          blank: 'collaboration-workspace-project-create-blank',
          folder: 'collaboration-workspace-project-import-folder',
          existing: 'collaboration-workspace-project-open-existing',
        }
      : {
          blank: `${testId}-blank`,
          folder: `${testId}-folder`,
          existing: `${testId}-existing`,
        }
  const items = [
    {
      label: messages.blankProject,
      icon: SquarePen,
      testId: optionTestIds.blank,
      onSelect: () => onSelect('blank'),
    },
    ...(supportsLocalImport
      ? [
          {
            label: messages.addFolder,
            icon: FolderPlus,
            testId: optionTestIds.folder,
            onSelect: () => onSelect('folder'),
          },
          {
            label: messages.importExistingProject,
            icon: FolderOpen,
            testId: optionTestIds.existing,
            onSelect: () => onSelect('existing'),
          },
        ]
      : []),
  ]
  const triggerClassName = `${className} collaboration-project-create-trigger`

  if (items.length === 1) {
    return (
      <button
        type="button"
        className={triggerClassName}
        data-testid={testId}
        aria-label={messages.addProject}
        onClick={items[0].onSelect}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {messages.addProject}
      </button>
    )
  }

  return (
    <ActionMenu
      ariaLabel={messages.addProject}
      icon={Plus}
      items={items}
      menuTestId={`${testId}-menu`}
      placement="bottom-end"
      showTriggerTooltip={false}
      testId={testId}
      triggerClassName={triggerClassName}
      triggerLabel={messages.addProject}
    />
  )
}
