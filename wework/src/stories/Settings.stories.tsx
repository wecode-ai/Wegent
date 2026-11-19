import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { SectionTitle, SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import { MenuSelect } from '@/components/common/MenuSelect'

const meta = {
  title: 'Patterns/Settings',
  component: SettingsRow,
  parameters: {
    docs: {
      description: {
        component:
          'Compose settings with SectionTitle, SettingsGroup and SettingsRow. The row is layout only: give the actual control a visible label and associate validation with it. / 设置行只负责布局，调用方负责字段标签、校验和持久化。',
      },
    },
  },
} satisfies Meta<typeof SettingsRow>
export default meta
type Story = StoryObj<Record<string, never>>
export const Group: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    const [value, setValue] = useState('')
    return (
      <div className="max-w-2xl">
        <SectionTitle title={t('title')} />
        <SettingsGroup>
          <SettingsRow
            label={t('language')}
            description={t('description')}
            requiredLabel={t('required')}
            error={value ? undefined : t('validation')}
          >
            <MenuSelect
              testId="catalog-settings-language"
              accessibleLabel={t('language')}
              value={value}
              onChange={setValue}
              placeholder={t('choose')}
              invalid={!value}
              options={[
                { value: 'en', label: 'English' },
                { value: 'zh-CN', label: '中文' },
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </div>
    )
  },
}
