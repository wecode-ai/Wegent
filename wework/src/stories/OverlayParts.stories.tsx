import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverArrow,
  PopoverShortcut,
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  HoverCardArrow,
  Menu,
  MenuContextTrigger,
  MenuContent,
  MenuItem,
  MenuItemIcon,
  MenuShortcut,
  MenuItems,
} from '@wegent/collaboration/controls'
import { Button } from '@/components/ui/button'
import { Copy } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/OverlayParts', component: Popover } satisfies Meta<typeof Popover>
export default meta
type Story = StoryObj<Record<string, never>>
export const ArrowAndShortcut: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    return (
      <Popover>
        <PopoverTrigger
          shortcut="mod+i"
          render={<Button variant="outline" />}
          data-testid="catalog-popover-shortcut"
        >
          {t('open')} <PopoverShortcut />
        </PopoverTrigger>
        <PopoverContent aria-label={t('details')} className="max-w-72 p-4">
          <PopoverArrow className="h-2 w-2 rotate-45 border border-border bg-popover" />
          {t('description')}
        </PopoverContent>
      </Popover>
    )
  },
}
export const HoverArrow: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    return (
      <HoverCard>
        <HoverCardTrigger
          render={<Button variant="outline" />}
          data-testid="catalog-hover-arrow-trigger"
        >
          {t('hover')}
        </HoverCardTrigger>
        <HoverCardContent aria-label={t('details')} className="max-w-72 p-4">
          <HoverCardArrow className="h-2 w-2 rotate-45 border border-border bg-popover" />
          {t('description')}
        </HoverCardContent>
      </HoverCard>
    )
  },
}
export const ContextAndData: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    const [value, setValue] = useState('')
    return (
      <div className="space-y-3">
        <Menu onAction={setValue}>
          <MenuContextTrigger
            tabIndex={0}
            className="flex min-h-32 max-w-sm items-center justify-center rounded-lg border border-dashed border-border p-4"
            data-testid="catalog-context-menu-trigger"
          >
            {t('contextMenuHint')}
          </MenuContextTrigger>
          <MenuContent aria-label={t('more')}>
            <MenuItem value="copy" shortcut="mod+c" data-testid="catalog-context-copy">
              <MenuItemIcon>
                <Copy className="h-4 w-4" />
              </MenuItemIcon>
              {t('copy')}
              <MenuShortcut />
            </MenuItem>
            <MenuItems
              items={[
                { value: 'rename', label: t('rename') },
                { value: 'disabled', label: t('disabled'), disabled: true },
              ]}
            />
          </MenuContent>
        </Menu>
        <output>{value}</output>
      </div>
    )
  },
}
