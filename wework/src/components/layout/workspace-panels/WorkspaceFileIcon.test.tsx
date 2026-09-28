import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { WorkspaceFileIcon } from './WorkspaceFileIcon'

test.each([
  ['/fixture/repo/api.py', 'python'],
  ['C:\\fixture\\repo\\API.PY', 'python'],
  ['/fixture/repo/main.ts', 'typescript'],
  ['/fixture/repo/view.tsx', 'react'],
  ['/fixture/repo/README.md', 'markdown'],
  ['/fixture/repo/Dockerfile', 'docker'],
  ['/fixture/repo/unknown.fixture', 'default'],
])('renders the bundled icon for %s', (path, token) => {
  render(<WorkspaceFileIcon path={path} testId="file-icon" />)
  const icon = screen.getByTestId('file-icon')
  expect(icon).toHaveAttribute('data-file-icon', token)
  expect(icon).toHaveAttribute('viewBox', '0 0 16 16')
  expect(icon.querySelector('path[d]')).not.toBeNull()
  expect(icon.querySelector('[fill="currentColor"], [fill="currentcolor"]')).not.toBeNull()
  expect(icon).not.toHaveClass('text-text-secondary', 'text-text-muted')
  expect(icon.querySelector('symbol, script, image')).toBeNull()
})
