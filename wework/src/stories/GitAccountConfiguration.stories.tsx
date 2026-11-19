import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  GitAccountConfigurationButton,
  GitAccountConfigurationProvider,
} from '@wegent/collaboration/controls'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/GitAccountConfiguration',
  component: GitAccountConfigurationButton,
} satisfies Meta<typeof GitAccountConfigurationButton>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ failure = false, readOnly = false, text = false }) {
  const { i18n } = useTranslation()
  const translate = createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')
  const [result, setResult] = useState('')
  return (
    <div className="space-y-3">
      <GitAccountConfigurationProvider
        value={{
          baseUrl: 'https://example.test',
          canConfigureDevice: () => !readOnly,
          openUrl: url => {
            setResult(url)
            return !failure
          },
        }}
      >
        <GitAccountConfigurationButton
          failure={{
            code: 'credentials-required',
            domain: 'github.com',
            message: 'Example authentication required',
          }}
          translate={translate}
          testId="catalog-git-configure"
          deviceId="example-device"
          appearance={text ? 'text' : 'button'}
        />
      </GitAccountConfigurationProvider>
      <output aria-live="polite">{result}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const OpenFailure: Story = { render: () => <Example failure /> }
export const ReadOnlyDevice: Story = { render: () => <Example readOnly /> }
export const Inline: Story = { render: () => <Example text /> }
