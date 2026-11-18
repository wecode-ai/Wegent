import '@/i18n'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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

  test('uses the current group sources after the selected source disappears', () => {
    const manage = vi.fn()
    const view = render(
      <PluginConnectorSection
        connectors={connectors}
        installed
        onManage={manage}
        authBySlug={{ 'tianhe-2': 'connected' }}
      />
    )
    fireEvent.click(screen.getByTestId('plugin-connection-manage-group:tianhe'))
    view.rerender(
      <PluginConnectorSection connectors={connectors.slice(0, 2)} installed onManage={manage} />
    )
    expect(screen.getByTestId('plugin-connector-source-select')).toHaveValue('tianhe-0')
    expect(screen.queryByRole('option', { name: /git.three.example/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('plugin-connector-source-continue'))
    expect(manage).toHaveBeenCalledExactlyOnceWith('tianhe-0')
  })

  test('a removed group closes and cannot reopen itself when it returns', () => {
    const view = render(<PluginConnectorSection connectors={connectors} installed />)
    fireEvent.click(screen.getByTestId('plugin-connection-manage-group:tianhe'))
    view.rerender(<PluginConnectorSection connectors={[{ slug: 'other' }]} installed />)
    expect(screen.queryByTestId('plugin-connector-source-dialog')).not.toBeInTheDocument()
    view.rerender(<PluginConnectorSection connectors={connectors} installed />)
    expect(screen.queryByTestId('plugin-connector-source-dialog')).not.toBeInTheDocument()
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce()
  })

  test('native modal ownership stays stable across status updates and returns focus on close', async () => {
    const view = render(<PluginConnectorSection connectors={connectors} installed />)
    const trigger = screen.getByTestId('plugin-connection-manage-group:tianhe')
    await userEvent.click(trigger)
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce()
    view.rerender(
      <PluginConnectorSection
        connectors={connectors}
        installed
        authBySlug={{ 'tianhe-1': 'connected' }}
      />
    )
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce()
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled()
    screen.getByTestId('plugin-connector-source-select').focus()
    await userEvent.click(screen.getByTestId('plugin-connector-source-cancel'))
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce()
    expect(trigger).toHaveFocus()
  })

  test('unmounting releases the native modal and cancel never invokes authentication', () => {
    const manage = vi.fn()
    const view = render(
      <PluginConnectorSection connectors={connectors} installed onManage={manage} />
    )
    fireEvent.click(screen.getByTestId('plugin-connection-manage-group:tianhe'))
    fireEvent(
      screen.getByTestId('plugin-connector-source-dialog'),
      new Event('cancel', { cancelable: true })
    )
    expect(manage).not.toHaveBeenCalled()
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('plugin-connection-manage-group:tianhe'))
    view.unmount()
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(2)
  })
})
