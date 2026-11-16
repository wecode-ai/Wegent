import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonalIssueErrors } from './PersonalIssueErrors'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('announces both failures once while keeping source retries independent', () => {
  const projects = { error: true, reload: vi.fn() }
  const independent = { error: 'Private API unavailable', reload: vi.fn() }
  render(<PersonalIssueErrors projects={projects} independent={independent} />)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('alert')).toHaveTextContent('personalHome.loadFailed')
  expect(screen.getByRole('alert')).toHaveTextContent(independent.error)
  fireEvent.click(screen.getByTestId('personal-home-retry'))
  expect(projects.reload).toHaveBeenCalledOnce()
  expect(independent.reload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('independent-issues-retry'))
  expect(independent.reload).toHaveBeenCalledOnce()
})

it('keeps an independent failure visible when project work loaded successfully', () => {
  render(
    <PersonalIssueErrors
      projects={{ error: false, reload: vi.fn() }}
      independent={{ error: 'Private API unavailable', reload: vi.fn() }}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Private API unavailable')
  expect(screen.queryByTestId('personal-home-retry')).not.toBeInTheDocument()
  expect(screen.getByTestId('independent-issues-retry')).toBeInTheDocument()
})

it('does not announce a failure when both sources are healthy', () => {
  render(
    <PersonalIssueErrors
      projects={{ error: false, reload: vi.fn() }}
      independent={{ error: null, reload: vi.fn() }}
    />
  )
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
