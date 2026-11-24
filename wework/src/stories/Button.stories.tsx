import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'

const meta = {
  title: 'Controls/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          'Shared Button, re-exported by Wework. Use one primary action per group. Icon-only buttons require an accessible name and Tooltip. / 共享按钮；每组至多一个主操作，纯图标按钮需要名称与提示。',
      },
    },
  },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'primary',
        'secondary',
        'outline',
        'ghost',
        'destructive',
        'destructive-ghost',
        'link',
        'unstyled',
      ],
    },
    size: { control: 'select', options: ['default', 'sm', 'lg', 'icon'] },
    disabled: { control: 'boolean' },
  },
  args: { variant: 'primary', size: 'default', disabled: false, type: 'button' },
  render: function Example(args) {
    const { t } = useTranslation('componentCatalog')
    return (
      <Button {...args} data-testid="catalog-button">
        {t('save')}
      </Button>
    )
  },
} satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Disabled: Story = { args: { disabled: true } }
export const Destructive: Story = { args: { variant: 'destructive' } }
export const Pending: Story = {
  args: { disabled: true },
  render: function Example(args) {
    const { t } = useTranslation('componentCatalog')
    return (
      <Button {...args} aria-busy="true" data-testid="catalog-pending-button">
        <CompositedSpinner className="h-3 w-3" />
        {t('pending')}
      </Button>
    )
  },
}
export const LongLabel: Story = {
  render: function Example(args) {
    const { t } = useTranslation('componentCatalog')
    return (
      <Button
        {...args}
        className="h-auto max-w-full whitespace-normal"
        data-testid="catalog-long-button"
      >
        {t('long')}
      </Button>
    )
  },
}
