import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import chinese from '@/i18n/locales/zh-CN/common.json'
import english from '@/i18n/locales/en/common.json'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueEditor } from './IndependentIssueEditor'
import { IndependentIssueDialog } from './IndependentIssueDialog'

afterEach(cleanup)

async function createTestI18n() {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh-CN',
    defaultNS: 'common',
    resources: { 'zh-CN': { common: chinese }, en: { common: english } },
  })
  return i18n
}

it('updates the current person and assignee labels when an open draft changes language', async () => {
  const i18n = await createTestI18n()
  const api = { projects: vi.fn().mockResolvedValue({ items: [] }) } as unknown as PersonalIssuesApi
  render(
    <I18nextProvider i18n={i18n}>
      <IndependentIssueEditor
        api={api}
        userId={7}
        issue={null}
        busy={false}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    </I18nextProvider>
  )
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Keep this draft' },
  })
  expect(within(screen.getByRole('region', { name: '参与者' })).getByText('我')).toBeVisible()
  expect(screen.getByTestId('independent-issue-assignee')).toHaveAccessibleDescription('人员 · 我')
  await act(() => i18n.changeLanguage('en'))
  const participants = screen.getByRole('region', { name: 'Participants' })
  expect(within(participants).getByText('Me')).toBeVisible()
  expect(within(participants).queryByText('我')).not.toBeInTheDocument()
  expect(screen.getByTestId('independent-issue-assignee')).toHaveAccessibleDescription(
    'People · Me'
  )
  expect(screen.getByTestId('independent-issue-title')).toHaveValue('Keep this draft')
})

it('updates an existing save warning when the language changes without resetting its draft', async () => {
  const i18n = await createTestI18n()
  const api = {
    projects: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
  } as unknown as PersonalIssuesApi
  render(
    <I18nextProvider i18n={i18n}>
      <IndependentIssueDialog
        api={api}
        userId={7}
        issueId={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </I18nextProvider>
  )
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Preserved draft' },
  })
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    chinese.issue_creation.save_unconfirmed
  )
  await act(() => i18n.changeLanguage('en'))
  expect(screen.getByRole('alert')).toHaveTextContent(english.issue_creation.save_unconfirmed)
  expect(screen.getByTestId('independent-issue-title')).toHaveValue('Preserved draft')
  expect(api.create).toHaveBeenCalledOnce()
})
