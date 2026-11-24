import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CloudProject } from '@/api/deliveries'
import { ProjectSpacePickerMenu } from '@/features/todo/ProjectSpacePickerMenu'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/ProjectSpacePickerMenu',
  component: ProjectSpacePickerMenu,
} satisfies Meta<typeof ProjectSpacePickerMenu>
export default meta
type Story = StoryObj<Record<string, never>>
const projects: CloudProject[] = ['local', 'backend'].map((store, index) => ({
  id: String(index + 1),
  public_id: 'example-' + index,
  project_key: 'EXAMPLE-' + index,
  name: store === 'local' ? 'Example local project' : 'Example cloud project',
  description: '',
  project_store: store as 'local' | 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}))
function Example({ empty = false }) {
  const { t } = useTranslation('componentCatalog')
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<CloudProject | null>(null)
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  return (
    <div className="space-y-4">
      <Button
        ref={setTrigger}
        data-testid="catalog-project-space-trigger"
        onClick={() => setOpen(current => !current)}
      >
        {project?.name ?? t('project')}
      </Button>
      {open && (
        <ProjectSpacePickerMenu
          projects={empty ? [] : projects}
          project={project}
          anchor={trigger}
          onClose={() => setOpen(false)}
          onSelect={next => {
            setProject(next)
            setOpen(false)
          }}
          onRemoveProject={() => {
            setProject(null)
            setOpen(false)
          }}
        />
      )}
      <output>{project?.project_key}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
