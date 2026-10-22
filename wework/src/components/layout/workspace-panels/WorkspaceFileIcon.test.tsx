import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { WorkspaceFileIcon } from './WorkspaceFileIcon'

test.each([
  ['/fixture/repo/api.py', 'python', 'light-dark(#1a85d4, #69b1ff)'],
  ['C:\\fixture\\repo\\API.PY', 'python', 'light-dark(#1a85d4, #69b1ff)'],
  ['/fixture/repo/main.ts', 'typescript', 'light-dark(#1a85d4, #69b1ff)'],
  ['/fixture/repo/view.tsx', 'react', 'light-dark(#1ca1c7, #68cdf2)'],
  ['/fixture/repo/README.md', 'markdown', 'light-dark(#199f43, #5ecc71)'],
  ['/fixture/repo/Dockerfile', 'docker', 'light-dark(#1a85d4, #69b1ff)'],
  ['/fixture/repo/unknown.fixture', 'default', 'light-dark(#84848a, #adadb1)'],
])('renders the bundled icon with its theme colors for %s', (path, token, color) => {
  render(<WorkspaceFileIcon path={path} testId="file-icon" />)
  const icon = screen.getByTestId('file-icon')
  expect(icon).toHaveAttribute('data-file-icon', token)
  expect(icon).toHaveAttribute('viewBox', '0 0 16 16')
  expect(icon.querySelector('path[d]')).not.toBeNull()
  expect(icon).toHaveStyle({ color })
  expect(icon.querySelector('[fill="currentColor"], [fill="currentcolor"]')).not.toBeNull()
  expect(icon).not.toHaveClass('text-text-secondary', 'text-text-muted')
  expect(icon.querySelector('symbol, script, image')).toBeNull()
})
