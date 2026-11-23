import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsiblePanel,
} from '@wegent/collaboration/controls/Collapsible'
import { TextField } from '@wegent/collaboration/controls/TextField'

const meta = {
  title: 'Primitives/Collapsible',
  component: CollapsibleRoot,
  parameters: {
    docs: {
      description: {
        component:
          'SDK owns expansion, keyboard and ARIA. Closed panels keep their field values. / 统一折叠控件，关闭后保留输入内容。',
      },
    },
  },
} satisfies Meta<typeof CollapsibleRoot>
export default meta
type Story = StoryObj<typeof meta>

export const Details: Story = {
  render: () => (
    <CollapsibleRoot className="max-w-md rounded-xl border border-border p-3">
      <CollapsibleTrigger data-testid="catalog-collapsible-toggle">
        Advanced options / 高级设置
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <label className="mt-3 block text-sm">
          Name / 名称
          <TextField
            data-testid="catalog-collapsible-field"
            defaultValue="Draft / 草稿"
            className="mt-2 w-full"
          />
        </label>
      </CollapsiblePanel>
    </CollapsibleRoot>
  ),
}
export const InitiallyExpanded: Story = {
  ...Details,
  render: () => (
    <CollapsibleRoot defaultOpen>
      <CollapsibleTrigger data-testid="catalog-expanded-toggle">Details / 详情</CollapsibleTrigger>
      <CollapsiblePanel>
        Expanded initially; collapse with Enter or Space. / 支持键盘展开收起。
      </CollapsiblePanel>
    </CollapsibleRoot>
  ),
}
