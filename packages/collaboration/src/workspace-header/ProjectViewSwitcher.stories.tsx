import { useState } from 'react'
import { CollaborationTheme } from '../theme'
import '../styles.css'
import {
  ProjectViewSwitcher,
  groupedProjectViewMetadata,
  type CollaborationProjectView,
  type CollaborationProjectViewOption,
} from './ProjectViewSwitcher'

const labels = {
  board: '看板',
  calendar: '日历',
  gantt: '甘特',
  table: '表格',
  milestones: '里程碑',
  files: '文件',
  manage: '项目设置',
}
const views: CollaborationProjectView[] = [
  'board',
  'calendar',
  'gantt',
  'table',
  'milestones',
  'files',
  'manage',
]
const groupedOptions = views.map((id) => ({
  id,
  label: labels[id],
  testId: `collaboration-tab-${id}`,
  ...groupedProjectViewMetadata[id],
}))

interface PreviewArgs {
  value: CollaborationProjectView
  compact?: boolean
  options?: CollaborationProjectViewOption[]
  theme?: 'light' | 'dark'
}

function Preview({
  value: initialValue,
  compact = false,
  options = groupedOptions,
}: PreviewArgs) {
  const [value, setValue] = useState(initialValue)
  return (
    <ProjectViewSwitcher
      compact={compact}
      options={options}
      value={value}
      onChange={setValue}
    />
  )
}

function render(args: PreviewArgs) {
  return (
    <CollaborationTheme key={args.theme} mode={args.theme ?? 'light'}>
      <div
        style={{
          width: args.compact ? 360 : 720,
          maxWidth: '100%',
          boxSizing: 'border-box',
          background: 'rgb(var(--color-bg-base))',
          padding: 'var(--space-xl)',
        }}
      >
        <Preview key={`${args.value}:${args.compact}`} {...args} />
      </div>
    </CollaborationTheme>
  )
}

export default {
  title: 'Navigation/ProjectViewSwitcher',
  component: ProjectViewSwitcher,
  render,
  parameters: { layout: 'padded' },
  argTypes: { theme: { control: 'inline-radio', options: ['light', 'dark'] } },
}

export const GroupedWork = { args: { value: 'board' } }
export const GroupedPlanTimeline = { args: { value: 'gantt' } }
export const GroupedPlanMilestones = { args: { value: 'milestones' } }
export const GroupedAdmin = { args: { value: 'files' } }
export const GroupedAdminFilesOnly = {
  args: {
    value: 'files',
    options: groupedOptions.filter((option) => option.id !== 'manage'),
  },
}
export const GroupedPlanNoMilestones = {
  args: {
    value: 'gantt',
    options: groupedOptions.filter((option) => option.id !== 'milestones'),
  },
}
export const UngroupedFallback = {
  args: {
    value: 'board',
    options: groupedOptions.map(({ id, label, testId }) => ({
      id,
      label,
      testId,
    })),
  },
}
export const Compact = { args: { value: 'gantt', compact: true } }
export const CompactOpen = {
  ...Compact,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    canvasElement
      .querySelectorAll<HTMLButtonElement>(
        '[data-testid="collaboration-compact-trigger"]',
      )
      .forEach((trigger) => trigger.click())
  },
}
