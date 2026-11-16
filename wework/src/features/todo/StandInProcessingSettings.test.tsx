import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { StandInProcessingSettings } from './StandInProcessingSettings'

function fixture(
  policy: StandInHandlingPolicy = { automatic: true, askBeforeAct: true },
  disabled = false,
  sessionScope: 'source' | 'issue' | 'schedule' = 'source'
) {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInProcessingSettings
      disabled={disabled}
      sessionScope={sessionScope}
      rows={[
        {
          key: 'group',
          name: '产品研发群',
          testId: 'group-policy',
          outbound: true,
          policy,
          onChange,
        },
      ]}
    />
  )
  const expand = () => user.click(screen.getByTestId('stand-in-processing-settings-toggle'))
  return { user, onChange, expand }
}

it('starts collapsed and reveals three matching switches without changing policies', async () => {
  const { expand, onChange } = fixture()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-processing-settings-toggle')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  await expand()
  const group = within(screen.getByRole('group', { name: '产品研发群' }))
  expect(group.getAllByRole('switch')).toHaveLength(3)
  expect(group.getByRole('switch', { name: /收到后立即处理/ })).toBeEnabled()
  expect(group.getByRole('switch', { name: /每次新建会话/ })).toHaveAttribute(
    'aria-checked',
    'false'
  )
  expect(group.getByText('发送前逐次确认')).toBeVisible()
  expect(group.queryByRole('combobox')).not.toBeInTheDocument()
  await expand()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
})

it.each([true, false])(
  'defaults to reuse and enables independent sessions without changing timing or grants: %s',
  async immediate => {
    const policy = { automatic: true, askBeforeAct: true, immediate }
    const { expand, user, onChange } = fixture(policy)
    await expand()
    const toggle = screen.getByTestId('group-policy-session-strategy')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(onChange).toHaveBeenCalledWith({ ...policy, sessionStrategy: 'independent' })
  }
)

it('switches an explicitly independent source back to reuse', async () => {
  const policy = {
    automatic: true,
    askBeforeAct: true,
    immediate: false,
    sessionStrategy: 'independent' as const,
  }
  const { expand, user, onChange } = fixture(policy)
  await expand()
  expect(screen.getByTestId('group-policy-session-strategy')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await user.click(screen.getByTestId('group-policy-session-strategy'))
  expect(onChange).toHaveBeenCalledWith({ ...policy, sessionStrategy: 'reuse' })
})

it('supports keyboard expansion and changing the session switch', async () => {
  const { user, onChange } = fixture()
  await user.tab()
  expect(screen.getByTestId('stand-in-processing-settings-toggle')).toHaveFocus()
  await user.keyboard(' ')
  await user.tab()
  await user.tab()
  expect(screen.getByTestId('group-policy-session-strategy')).toHaveFocus()
  await user.keyboard(' ')
  expect(onChange).toHaveBeenCalledWith({
    automatic: true,
    askBeforeAct: true,
    sessionStrategy: 'independent',
  })
})

it.each(['independent', 'reuse'] as const)(
  'changes timing without changing conversation strategy: %s',
  async sessionStrategy => {
    const policy = { automatic: true, askBeforeAct: false, immediate: false, sessionStrategy }
    const { expand, user, onChange } = fixture(policy)
    await expand()
    await user.click(screen.getByTestId('group-policy'))
    expect(onChange).toHaveBeenCalledWith({ ...policy, immediate: true })
  }
)

it.each([
  { disabled: true, automatic: true },
  { disabled: false, automatic: false },
])('keeps unavailable policies disabled after expansion: %j', async ({ disabled, automatic }) => {
  const { expand } = fixture({ automatic, askBeforeAct: true }, disabled)
  await expand()
  expect(screen.getByTestId('group-policy')).toBeDisabled()
  expect(screen.getByTestId('group-policy-session-strategy')).toBeDisabled()
})

it.each(['issue', 'schedule'] as const)(
  'does not offer a source strategy that overrides %s ownership',
  async sessionScope => {
    const { expand } = fixture({ automatic: true, askBeforeAct: true }, false, sessionScope)
    await expand()
    expect(screen.getByTestId('group-policy')).toBeEnabled()
    expect(screen.queryByTestId('group-policy-session-strategy')).not.toBeInTheDocument()
  }
)
