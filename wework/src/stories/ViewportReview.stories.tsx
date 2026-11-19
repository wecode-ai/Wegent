import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Field, FieldLabel } from '@wegent/collaboration/controls/Field'
import { SegmentedControl } from '@wegent/collaboration/controls/SegmentedControl'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { useTranslation } from '@/hooks/useTranslation'

const surfaces = [
  { value: 'pages-runtimesettings--ready', label: 'Runtime' },
  { value: 'patterns-composercomparison--three-production-flows', label: 'Composer' },
  { value: 'business-contentlayout--quick-phrase-actions', label: 'Quick phrases / 快捷短语' },
  { value: 'business-taskdescriptioneditor--editable', label: 'Task description / 任务描述' },
  { value: 'patterns-inlinepanel--template-inline-step', label: 'Inline step / 内嵌步骤' },
  { value: 'controls-sortable--production-board-states', label: 'Board states / 看板状态' },
  { value: 'business-conversationqueue--mixed-ownership', label: 'Conversation queue / 消息队列' },
  { value: 'business-planningdraganddrop--board', label: 'Project board / 项目看板' },
  { value: 'controls-menus--weekday-scheduling', label: 'Schedule controls / 排期控件' },
  { value: 'controls-menus--action-densities', label: 'Action menu sizes / 操作菜单尺寸' },
]
const meta = {
  title: 'Patterns/ViewportReview',
  parameters: {
    docs: {
      description: {
        component:
          'One iframe runs the real production Story; changing its width preserves the same state and tests real media queries at 360, 768 or 1280px. These are local service-port fixtures, not native runtime acceptance. / 同一独立视口运行真实生产组件示例，切换宽度保留当前状态并验证媒体查询；服务端口使用本地样例，不代表桌面运行时验收。',
      },
    },
  },
} satisfies Meta
export default meta
type Story = StoryObj<Record<string, never>>
function Comparison({ theme, locale }: { theme: string; locale: string }) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState(surfaces[0].value)
  const [width, setWidth] = useState('360')
  return (
    <div className="space-y-4">
      <Field className="max-w-md">
        <FieldLabel>{t('reviewSurface')}</FieldLabel>
        <SelectField
          value={value}
          options={surfaces}
          onChange={setValue}
          accessibleLabel={t('reviewSurface')}
          testId="catalog-review-surface"
        />
      </Field>
      <Field className="max-w-md">
        <FieldLabel>{t('reviewViewport')}</FieldLabel>
        <SegmentedControl
          value={width}
          onChange={setWidth}
          label={t('reviewViewport')}
          options={['360', '768', '1280'].map(value => ({
            value,
            label: value + 'px',
            testId: 'catalog-review-width-' + value,
          }))}
        />
      </Field>
      <div className="overflow-x-auto pb-4" data-testid="catalog-review-viewports">
        <iframe
          key={`${value}-${locale}-${theme}`}
          title={`${surfaces.find(item => item.value === value)?.label} ${width}px`}
          width={Number(width)}
          height={720}
          data-testid="catalog-review-viewport"
          className="rounded-lg border-0 bg-background ring-1 ring-border"
          src={`./iframe.html?id=${encodeURIComponent(value)}&viewMode=story&globals=${encodeURIComponent(`theme:${theme};locale:${locale}`)}`}
        />
      </div>
    </div>
  )
}
export const ProductionSurfaces: Story = {
  render: (_args, context) => (
    <Comparison
      theme={context.globals.theme === 'dark' ? 'dark' : 'light'}
      locale={context.globals.locale === 'en' ? 'en' : 'zh-CN'}
    />
  ),
}
