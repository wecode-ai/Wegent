import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemberSearchPicker } from '@wegent/collaboration/controls/entities'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Business/MemberSearchPicker', component: MemberSearchPicker } satisfies Meta<
  typeof MemberSearchPicker
>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({ empty = false, loading = false, failure = false, saving = false }) {
  const { t } = useTranslation('componentCatalog')
  const [query, onQueryChange] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const users = empty
    ? []
    : [
        { id: 2, user_name: 'Alex' },
        { id: 3, user_name: 'Bo' },
      ].filter(user => user.user_name.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="max-w-lg">
      <MemberSearchPicker
        query={query}
        onQueryChange={onQueryChange}
        users={users}
        selectedUserIds={selected}
        onSelect={user =>
          setSelected(current => {
            const next = new Set(current)
            if (next.has(user.id)) next.delete(user.id)
            else next.add(user.id)
            return next
          })
        }
        placeholder={t('search')}
        emptyLabel={t('empty')}
        addLabel={t('person')}
        addingLabel={t('loading')}
        inputTestId="catalog-member-search"
        resultTestId={id => 'catalog-member-' + id}
        savingUserId={saving ? 2 : null}
        loadingLabel={loading ? t('loading') : undefined}
        error={failure ? 'Example directory failure' : undefined}
      />
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
export const Loading: Story = { render: () => <Example loading /> }
export const DirectoryFailure: Story = { render: () => <Example failure /> }
export const Saving: Story = { render: () => <Example saving /> }
