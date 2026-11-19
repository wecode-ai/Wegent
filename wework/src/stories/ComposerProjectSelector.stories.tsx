import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ComposerContextButton, ComposerProjectSelector } from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Cloud, Folder, Laptop, Workflow } from 'lucide-react'
const meta = {
  title: 'Business/ComposerProjectSelector',
  component: ComposerProjectSelector,
} satisfies Meta<typeof ComposerProjectSelector>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false, empty = false, long = false }) {
  const { t } = useTranslation('componentCatalog')
  const [value, onChange] = useState('local')
  return (
    <div className="max-w-sm space-y-3">
      <ComposerProjectSelector
        value={empty ? '' : value}
        options={
          empty
            ? []
            : [
                {
                  value: 'local',
                  label: long ? t('long') : t('localProject'),
                  description: t('localProject'),
                },
                { value: 'cloud', label: t('cloudProject'), description: t('cloudProject') },
                { value: 'disabled', label: t('disabled'), disabled: true },
              ]
        }
        onChange={onChange}
        label={t('project')}
        disabled={disabled}
        testId="catalog-composer-project"
      />
      <output>{empty ? '' : value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const Empty: Story = { render: () => <Example empty /> }
export const LongProjectName: Story = { render: () => <Example long /> }

export const ComposerContextRow: Story = {
  render: function ComposerContextRow() {
    const { t } = useTranslation('common')
    const { t: catalog } = useTranslation('componentCatalog')
    const [project, selectProject] = useState('local')
    const [executionMode, setExecutionMode] = useState<'current' | 'worktree'>('current')
    const [workspaceSelected, setWorkspaceSelected] = useState(true)
    return (
      <div className="flex max-w-2xl flex-wrap items-center gap-2 rounded-t-[20px] bg-muted/45 px-3 py-2">
        <ComposerContextButton
          aria-pressed={workspaceSelected}
          data-testid="catalog-composer-workspace"
          onClick={() => setWorkspaceSelected(current => !current)}
        >
          <Folder aria-hidden="true" className="size-4" />
          {workspaceSelected ? catalog('localProject') : t('personalHome.codeWorkspace')}
        </ComposerContextButton>
        <ComposerProjectSelector
          value={project}
          options={[
            {
              value: 'local',
              label: catalog('project'),
              icon: <Laptop aria-hidden="true" className="size-4" />,
            },
            {
              value: 'cloud',
              label: catalog('cloudProject'),
              icon: <Cloud aria-hidden="true" className="size-4" />,
            },
          ]}
          icon={
            project === 'local' ? (
              <Laptop aria-hidden="true" className="size-4" />
            ) : (
              <Cloud aria-hidden="true" className="size-4" />
            )
          }
          onChange={selectProject}
          label={catalog('project')}
          testId="catalog-composer-project"
        />
        <SelectField<'current' | 'worktree'>
          value={executionMode}
          options={[
            { value: 'current', label: t('workbench.execution_mode_current_workspace') },
            { value: 'worktree', label: t('workbench.execution_mode_git_worktree') },
          ]}
          triggerContent={
            <>
              {executionMode === 'current' ? (
                <Folder aria-hidden="true" className="size-4" />
              ) : (
                <Workflow aria-hidden="true" className="size-4" />
              )}
              {t(
                executionMode === 'current'
                  ? 'workbench.execution_mode_current_workspace'
                  : 'workbench.execution_mode_git_worktree'
              )}
            </>
          }
          accessibleLabel={t('workbench.execution_mode_label')}
          onChange={setExecutionMode}
          appearance="composer"
          testId="catalog-composer-execution"
        />
      </div>
    )
  },
}
