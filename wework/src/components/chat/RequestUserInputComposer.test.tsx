import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import { RequestUserInputCard } from './RequestUserInputCard'
import { RequestUserInputComposer } from './RequestUserInputComposer'

const payload: RequestUserInputPayload = {
  requestId: 91,
  questions: [{ id: 'audience', question: 'Who should receive the report?', is_other: true }],
}

function setup(initial = payload) {
  const submit = vi.fn().mockResolvedValue(false)
  const ignore = vi.fn()
  const view = (request: RequestUserInputPayload | null) => (
    <RequestUserInputComposer
      payload={request}
      renderQuestion={onCollapse =>
        request && (
          <RequestUserInputCard
            payload={request}
            onSubmit={submit}
            onIgnore={ignore}
            onCollapse={onCollapse}
          />
        )
      }
    >
      <input aria-label="Ordinary message" data-testid="ordinary-composer" />
    </RequestUserInputComposer>
  )
  const result = render(view(initial))
  return {
    ...result,
    update: (request: RequestUserInputPayload | null) => result.rerender(view(request)),
    submit,
    ignore,
  }
}

test.each(['button', 'Escape'])(
  '%s folds a question without losing its answer or cancelling',
  async action => {
    const h = setup()
    const answer = screen.getByTestId('request-user-input-custom-audience')
    await userEvent.type(answer, 'Project members only')
    const collapse = screen.getByTestId('request-user-input-ignore-button')
    expect(collapse).toHaveTextContent('收起')
    if (action === 'button') await userEvent.click(collapse)
    else fireEvent.keyDown(answer, { key: 'Escape' })
    expect(answer).not.toBeVisible()
    expect(screen.getByTestId('ordinary-composer')).toBeVisible()
    const expand = screen.getByTestId('request-user-input-expand')
    expect(expand).toHaveFocus()
    expect(h.ignore).not.toHaveBeenCalled()
    expect(h.submit).not.toHaveBeenCalled()
    await userEvent.click(expand)
    expect(screen.getByTestId('request-user-input-custom-audience')).toBe(answer)
    expect(answer).toHaveValue('Project members only')
    expect(screen.getByTestId('request-user-input-card')).toHaveFocus()
    expect(screen.queryByTestId('ordinary-composer')).not.toBeInTheDocument()
  }
)

test('retains folded answers across failed submissions and closes when the request is settled', async () => {
  const h = setup()
  await userEvent.type(screen.getByTestId('request-user-input-custom-audience'), 'Saved answer')
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(h.submit).toHaveBeenCalledOnce()
  await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  h.update({ ...payload })
  expect(screen.getByTestId('request-user-input-expand')).toBeVisible()
  await userEvent.click(screen.getByTestId('request-user-input-expand'))
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue('Saved answer')
  h.update(null)
  expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-expand')).not.toBeInTheDocument()
  expect(screen.getByTestId('ordinary-composer')).toBeVisible()
})

test('opens newly arriving questions without inheriting an old collapsed answer', async () => {
  const h = setup()
  await userEvent.type(screen.getByTestId('request-user-input-custom-audience'), 'Old answer')
  await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  h.update({ ...payload, requestId: 92 })
  expect(screen.queryByTestId('request-user-input-expand')).not.toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-audience')).toBeVisible()
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue('')
})

test('keeps MCP cancellation on the existing correlated response path', async () => {
  const h = setup({ ...payload, interactionKind: 'mcp_form' })
  expect(screen.getByTestId('request-user-input-ignore-button')).toHaveTextContent('取消')
  await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ requestId: 91, answers: {} }))
  expect(screen.queryByTestId('request-user-input-expand')).not.toBeInTheDocument()
  expect(screen.queryByTestId('ordinary-composer')).not.toBeInTheDocument()
})

test('keeps the ordinary composer and focus when a folded question expires or disappears', async () => {
  const h = setup()
  await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  const composer = screen.getByTestId('ordinary-composer')
  await userEvent.type(composer, 'Keep this message draft')
  h.update({ ...payload, expiresAtUnixMs: Date.now() - 1 })
  expect(screen.queryByTestId('request-user-input-expand')).not.toBeInTheDocument()
  expect(screen.getByTestId('ordinary-composer')).toBe(composer)
  expect(composer).toHaveFocus()
  expect(composer).toHaveValue('Keep this message draft')
  h.update(null)
  expect(screen.getByTestId('ordinary-composer')).toBe(composer)
  expect(composer).toHaveFocus()
})

test('reveals added grouped questions while preserving the first answer', async () => {
  const h = setup()
  await userEvent.type(
    screen.getByTestId('request-user-input-custom-audience'),
    'Saved first answer'
  )
  await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  h.update({
    ...payload,
    questions: [...payload.questions!, { id: 'timing', question: 'When?', is_other: true }],
  })
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue('Saved first answer')
  expect(screen.getByTestId('request-user-input-custom-timing')).toBeVisible()
})
