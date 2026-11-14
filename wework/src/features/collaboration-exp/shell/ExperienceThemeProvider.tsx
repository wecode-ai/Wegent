import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { CollaborationTheme, useDocumentTheme } from '@wegent/collaboration/theme'

type ThemeVariables = NonNullable<ComponentProps<typeof CollaborationTheme>['variables']>
const THEME_VARIABLE =
  /^--(?:color-|text-|experience-text-|font-|radius|shadow|space-|weight-|appearance-)/

/** Carry the experiment's actual scoped CSS through the shared body-portal context. */
export function ExperienceThemeProvider({ children }: { children: ReactNode }) {
  const mode = useDocumentTheme()
  const container = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<{
    mode: typeof mode
    variables: ThemeVariables
  } | null>(null)

  useLayoutEffect(() => {
    const scope = container.current?.querySelector<HTMLElement>(
      '[data-testid="collaboration-exp-app"]'
    )
    if (!scope) return
    const computed = getComputedStyle(scope)
    const variables = Object.fromEntries(
      Array.from(computed)
        .filter(name => THEME_VARIABLE.test(name))
        .map(name => [name, computed.getPropertyValue(name).trim()])
    ) as ThemeVariables
    setSnapshot({ mode, variables })
  }, [mode])

  return (
    <div ref={container} style={{ display: 'contents' }}>
      <CollaborationTheme
        mode={mode}
        variables={snapshot?.mode === mode ? snapshot.variables : undefined}
      >
        {children}
      </CollaborationTheme>
    </div>
  )
}
