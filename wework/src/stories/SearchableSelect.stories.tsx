import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
const meta = {
  title: 'Controls/SearchableSelect',
  component: SearchableSelect,
  parameters: {
    docs: {
      description: {
        component:
          'Production component built on UI SDK. Shared semantic tokens, keyboard behavior and touch targets. / 生产组件，基于 UI SDK，统一语义样式、键盘操作与触控尺寸。',
      },
    },
  },
} satisfies Meta<typeof SearchableSelect>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({
  multiple = false,
  empty = false,
  loading = false,
  error = false,
  disabled = false,
}: {
  multiple?: boolean
  empty?: boolean
  loading?: boolean
  error?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('first')
  const [values, setValues] = useState<string[]>(['first'])
  const common = {
    testId: 'catalog-search',
    accessibleLabel: t('name'),
    searchPlaceholder: t('search'),
    emptyLabel: t('empty'),
    disabled,
    options:
      empty || loading
        ? []
        : [
            { value: 'first', label: t('name'), group: 'A', description: t('description') },
            { value: 'second', label: t('title'), group: 'A' },
            { value: 'third', label: 'Example', group: 'B' },
            { value: 'disabled', label: t('disabled'), disabled: true, group: 'B' },
          ],
    searchStatus: loading ? (
      <p role="status">{t('pending')}</p>
    ) : error ? (
      <p role="alert" className="text-destructive">
        {t('failed')}
      </p>
    ) : undefined,
  }
  return multiple ? (
    <SearchableSelect {...common} multiple value={values} onChange={setValues} />
  ) : (
    <SearchableSelect {...common} value={value} onChange={setValue} />
  )
}
export const Default: Story = { render: () => <Example /> }
export const Multiple: Story = { render: () => <Example multiple /> }
export const Empty: Story = { render: () => <Example empty /> }
export const Loading: Story = { render: () => <Example loading /> }
export const Failure: Story = { render: () => <Example error /> }
export const Disabled: Story = { render: () => <Example disabled /> }
