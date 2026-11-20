import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
  Button,
} from '@/components/library'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/Popover', component: Popover } satisfies Meta<typeof Popover>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false }) {
  const { t } = useTranslation('componentCatalog')
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" />}
        disabled={disabled}
        data-testid="catalog-popover-trigger"
      >
        {t('open')}
      </PopoverTrigger>
      <PopoverContent aria-label={t('title')} className="w-72 p-4">
        <PopoverTitle className="text-base font-medium">{t('title')}</PopoverTitle>
        <PopoverDescription className="my-3 text-sm text-text-secondary">
          {t('description')}
        </PopoverDescription>
        <PopoverClose render={<Button variant="outline" />} data-testid="catalog-popover-close">
          {t('cancel')}
        </PopoverClose>
      </PopoverContent>
    </Popover>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
