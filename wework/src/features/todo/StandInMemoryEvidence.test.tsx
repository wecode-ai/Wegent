import type { StandInMemory } from '@/api/standIn'
import '@/i18n'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { StandInMemoryEvidence } from './StandInMemoryEvidence'

function memory(evidence?: StandInMemory['evidence']): StandInMemory {
  return {
    id: 'memory',
    content: 'Stored fact',
    scope: { kind: 'personal' },
    version: 1,
    createdAt: '',
    updatedAt: '',
    evidence,
  }
}

it.each([
  ['user', '用户原话'],
  ['assistant', '助手原话'],
])('shows conversation provenance without promoting the speaker: %s', (role, label) => {
  render(
    <StandInMemoryEvidence
      memory={memory({ taskId: 'conversation-1', role, excerpt: 'Original evidence' })}
    />
  )
  const evidence = screen.getByTestId('stand-in-memory-evidence')
  expect(evidence).toHaveTextContent(label)
  expect(evidence).toHaveTextContent('conversation-1')
  expect(evidence.querySelector('blockquote')).toHaveTextContent('Original evidence')
  expect(evidence).not.toHaveAttribute('open')
})

it('renders evidence as text, not executable markup', () => {
  render(<StandInMemoryEvidence memory={memory({ excerpt: '<img src=x onerror=alert(1)>' })} />)
  const evidence = screen.getByTestId('stand-in-memory-evidence')
  expect(evidence).toHaveTextContent('<img src=x onerror=alert(1)>')
  expect(evidence.querySelector('img')).toBeNull()
})

it('does not offer evidence when no excerpt was saved', () => {
  render(<StandInMemoryEvidence memory={memory()} />)
  expect(screen.queryByTestId('stand-in-memory-evidence')).toBeNull()
})
