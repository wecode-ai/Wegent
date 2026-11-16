import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IssueDetailSearchableSelect } from '@wegent/collaboration'
import { resolveThemeVariables, useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { ExperienceThemeProvider } from './ExperienceThemeProvider'

const sourceTheme = readFileSync('src/features/collaboration-exp/shell/ExperienceTheme.css', 'utf8')

let stylesheet: HTMLStyleElement
let previousMode: string | undefined

beforeEach(() => {
  previousMode = document.documentElement.dataset.theme
  document.documentElement.dataset.theme = 'light'
  stylesheet = document.createElement('style')
  stylesheet.textContent = sourceTheme
  document.head.append(stylesheet)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  stylesheet.remove()
  if (previousMode === undefined) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = previousMode
})

function PortalProbe() {
  const theme = useCollaborationPortalTheme()
  return createPortal(<div {...theme} data-testid="source-theme-portal" />, document.body)
}

function Content() {
  return (
    <ExperienceThemeProvider>
      <main data-testid="collaboration-exp-app">
        <PortalProbe />
        <IssueDetailSearchableSelect
          value=""
          options={[{ value: 'open', label: 'Open' }]}
          testId="source-theme-select"
          accessibleLabel="Status"
          searchPlaceholder="Search"
          emptyLabel="No results"
          onChange={() => undefined}
        />
      </main>
    </ExperienceThemeProvider>
  )
}

it('copies the actual scoped source tokens to a real body menu without changing global styles', () => {
  const globalStyle = document.documentElement.style.cssText
  const bodyStyle = document.body.style.cssText
  render(<Content />)
  const scope = screen.getByTestId('collaboration-exp-app')
  const portal = screen.getByTestId('source-theme-portal')
  expect(scope.contains(portal)).toBe(false)
  expect(portal.style.getPropertyValue('--color-text-primary')).toBe('26 28 31')
  expect(portal.style.getPropertyValue('--color-border-strong')).toBe('201 203 208')
  expect(portal.style.getPropertyValue('--text-sm')).toBe('13px')
  expect(portal.style.getPropertyValue('--experience-text-caption')).toBe('10px')
  fireEvent.click(screen.getByTestId('source-theme-select'))
  const menu = screen.getByTestId('source-theme-select-menu')
  expect(scope.contains(menu)).toBe(false)
  for (const name of ['--color-text-primary', '--color-border-strong', '--text-sm']) {
    expect(menu.style.getPropertyValue(name)).toBe(getComputedStyle(scope).getPropertyValue(name))
  }
  expect(document.documentElement.style.cssText).toBe(globalStyle)
  expect(document.body.style.cssText).toBe(bodyStyle)
})

it('updates open portals for both mode changes without feeding the previous snapshot back into inherited tokens', async () => {
  const nativeComputedStyle = getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const source = nativeComputedStyle(element, pseudo)
    if (element instanceof HTMLElement && element.dataset.testid === 'collaboration-exp-app') {
      // jsdom omits inherited custom properties that native computed styles include.
      const computed = document.createElement('div').style
      for (const name of Array.from(source)) {
        computed.setProperty(name, source.getPropertyValue(name))
      }
      const ancestor = element.closest<HTMLElement>('.collaboration-theme')!
      for (const name of Array.from(ancestor.style)) {
        if (name.startsWith('--') && !computed.getPropertyValue(name)) {
          computed.setProperty(name, ancestor.style.getPropertyValue(name))
        }
      }
      return computed
    }
    return source
  })
  render(<Content />)
  fireEvent.click(screen.getByTestId('source-theme-select'))
  for (const [mode, expectedBase] of [
    ['dark', '36 36 36'],
    ['light', '255 255 255'],
  ] as const) {
    await act(async () => {
      document.documentElement.dataset.theme = mode
    })
    await waitFor(() => {
      const menu = screen.getByTestId('source-theme-select-menu')
      expect(menu.dataset.theme).toBe(mode)
      expect(menu.style.getPropertyValue('--color-bg-base')).toBe(expectedBase)
      expect(menu.style.getPropertyValue('--color-reasoning-ultra-start')).toBe(
        resolveThemeVariables(mode)['--color-reasoning-ultra-start']
      )
      const scope = screen.getByTestId('collaboration-exp-app')
      for (const name of [
        '--color-popover',
        '--color-bg-surface',
        '--color-border-strong',
        '--font-ui',
      ]) {
        expect(menu.style.getPropertyValue(name)).toBe(
          getComputedStyle(scope).getPropertyValue(name)
        )
      }
    })
  }
})
