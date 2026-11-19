import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuItemIndicator,
  MenuSeparator,
} from '@wegent/collaboration/controls'
import { Button } from '@/components/ui/button'
import { Check } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/MenuChoices', component: Menu } satisfies Meta<typeof Menu>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false }) {
  const { t } = useTranslation('componentCatalog')
  const [checked, onCheckedChange] = useState(false)
  const [value, onValueChange] = useState('en')
  return (
    <div className="space-y-3">
      <Menu>
        <MenuTrigger render={<Button variant="outline" />} data-testid="catalog-menu-choices">
          {t('more')}
        </MenuTrigger>
        <MenuContent aria-label={t('more')} className="min-w-60">
          <MenuGroup>
            <MenuGroupLabel>{t('notifications')}</MenuGroupLabel>
            <MenuCheckboxItem
              value="notifications"
              checked={checked}
              onCheckedChange={onCheckedChange}
              disabled={disabled}
              closeOnSelect={false}
              data-testid="catalog-menu-checkbox"
            >
              <MenuItemIndicator>
                <Check className="h-4 w-4" />
              </MenuItemIndicator>
              {t('notifications')}
            </MenuCheckboxItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuRadioGroup value={value} onValueChange={onValueChange}>
            <MenuGroupLabel>{t('language')}</MenuGroupLabel>
            {['en', 'zh-CN'].map(language => (
              <MenuRadioItem
                key={language}
                value={language}
                disabled={disabled}
                data-testid={'catalog-menu-language-' + language}
              >
                <MenuItemIndicator>
                  <Check className="h-4 w-4" />
                </MenuItemIndicator>
                {language === 'en' ? 'English' : '中文'}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <output>
        {String(checked)} · {value}
      </output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const DisabledChoices: Story = { render: () => <Example disabled /> }
