import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginConnectorSection } from './PluginConnectorSection'

const connectors = ['git.one.example', 'git.two.example', 'git.three.example'].map((host, i) => ({
  slug: `tianhe-${i}`,
  displayName: host,
  description: `Use the PAT from ${host}`,
  authPolicy: 'optional' as const,
  authorizationGroup: { id: 'tianhe', displayName: '天河账号' },
}))

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
})

describe('connector source selection', () => {
  test('shows one entry and routes every chosen site by its original slug', () => {
    const manage = vi.fn()
    render(<PluginConnectorSection connectors={connectors} installed onManage={manage} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    for (const connector of connectors) {
      fireEvent.click(screen.getByTestId('plugin-connection-manage-group:tianhe'))
      expect(manage).not.toHaveBeenCalled()
      fireEvent.change(screen.getByTestId('plugin-connector-source-select'), {
        target: { value: connector.slug },
      })
      expect(screen.getByText(connector.description)).toBeVisible()
      fireEvent.click(screen.getByTestId('plugin-connector-source-continue'))
      expect(manage).toHaveBeenCalledExactlyOnceWith(connector.slug)
      expect(screen.queryByTestId('plugin-connector-source-dialog')).toBeNull()
      manage.mockClear()
    }
  })
  test('selects the connected site and supports dismissing without authentication', () => {
    const manage = vi.fn()
    render(
      <PluginConnectorSection
        connectors={connectors}
        installed
        onManage={manage}
        authBySlug={{ 'tianhe-2': 'connected' }}
      />
    )
    fireEvent.click(screen.getByTestId('plugin-connection-manage-group:tianhe'))
    expect(screen.getByTestId('plugin-connector-source-select')).toHaveValue('tianhe-2')
    expect(screen.getByTestId('plugin-connector-source-continue')).toHaveTextContent('退出登录')
    fireEvent.click(screen.getByTestId('plugin-connector-source-cancel'))
    expect(manage).not.toHaveBeenCalled()
  })
  test('preserves ungrouped identities and disables an uninstalled plugin', () => {
    const independent = { slug: 'other', authPolicy: 'optional' as const }
    render(<PluginConnectorSection connectors={[...connectors, independent]} installed={false} />)
    expect(
      within(screen.getByTestId('plugin-connector-section')).getAllByRole('button')
    ).toHaveLength(2)
    expect(screen.getByTestId('plugin-connection-manage-connector:other')).toBeDisabled()
    expect(screen.getByTestId('plugin-connection-manage-group:tianhe')).toBeDisabled()
  })
})
