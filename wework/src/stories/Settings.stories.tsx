import { SettingsShell } from '@/components/library'
import { Button } from '@/components/ui/button'
import { QuickPhrasesEditor } from '@wegent/collaboration/composer/QuickPhrasesEditor'
import { defaultQuickPhrases } from '@wegent/chat-core/composer-quick-phrases'
import { ProviderEditor } from '@/components/settings/ProviderEditor'
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

export const ResponsiveNavigation: Story = {
  parameters: { layout: 'fullscreen' },
  render: function Example() {
    const { t } = useTranslation('common')
    const [active, setActive] = useState('quick-phrases')
    const [selectedLanguage, setSelectedLanguage] = useState('en')
    const [phrases, setPhrases] = useState(() => defaultQuickPhrases.map(phrase => ({ ...phrase })))
    const entries = ['quick-phrases', 'model-settings', 'context']
    const label = (id: string) => t('workbench.settings_nav_' + id.replaceAll('-', '_'))
    return (
      <div className="h-[720px] w-full">
        <SettingsShell
          activeLabel={label(active)}
          onBack={() => setActive('quick-phrases')}
          navigation={close => (
            <nav data-testid="settings-sidebar-nav" className="min-h-0 flex-1 overflow-y-auto p-2">
              {entries.map(id => (
                <Button
                  key={id}
                  variant="ghost"
                  className="w-full justify-start"
                  aria-current={active === id ? 'page' : undefined}
                  data-testid={'settings-nav-' + id}
                  onClick={() => {
                    setActive(id)
                    close()
                  }}
                >
                  {label(id)}
                </Button>
              ))}
            </nav>
          )}
        >
          <h1 className="heading-base mb-6">{label(active)}</h1>
          {active === 'quick-phrases' ? (
            <QuickPhrasesEditor
              phrases={phrases}
              onChange={setPhrases}
              translate={(key, fallback, options) => t(key, { defaultValue: fallback, ...options })}
            />
          ) : (
            <MenuSelect
              accessibleLabel={label(active)}
              testId="catalog-settings-shell-selection"
              value={selectedLanguage}
              onChange={setSelectedLanguage}
              options={[
                { value: 'en', label: 'English' },
                { value: 'zh-CN', label: '中文' },
              ]}
            />
          )}
        </SettingsShell>
      </div>
    )
  },
}

export const ModelConnectionForm: Story = {
  render: function Example() {
    const { t } = useTranslation('modelConnections')
    const [open, setOpen] = useState(false)
    return (
      <>
        <Button data-testid="catalog-provider-open" onClick={() => setOpen(true)}>
          {t('addProvider')}
        </Button>
        {open && (
          <ProviderEditor
            initial={{
              id: 'catalog-provider',
              name: '',
              base_url: '',
              api_format: 'openai-responses',
              models: [],
            }}
            snapshot={{
              path: '',
              revision: 'catalog',
              providers: [],
              loadedAt: '2026-11-19T00:00:00Z',
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    )
  },
}
