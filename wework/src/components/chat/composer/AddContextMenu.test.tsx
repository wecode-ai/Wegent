import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import enCommon from '@/i18n/locales/en/common.json'
import { AddContextMenu } from './AddContextMenu'

describe('AddContextMenu', () => {
  test('uses the English host resource for the visible plan mode description', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'en', resources: { en: { common: enCommon } } })
    render(
      <I18nextProvider i18n={i18n}>
        <AddContextMenu disabled={false} onFileSelect={vi.fn()} onSetPlanMode={vi.fn()} />
      </I18nextProvider>
    )
    fireEvent.click(screen.getByTestId('add-context-button'))
    expect(screen.getByText('Plan mode')).toBeVisible()
    expect(screen.getByText('Enable plan mode')).toBeVisible()
  })

  test('explains that pending supervision starts with the task', () => {
    render(
      <AddContextMenu
        disabled={false}
        onFileSelect={vi.fn()}
        onConfigureSupervisor={vi.fn()}
        supervisorEnabled
        supervisorPending
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_pending_menu'
    )
  })
})
