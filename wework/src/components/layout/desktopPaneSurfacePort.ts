const surfaceScopes = new WeakMap<HTMLElement, string>()

/** The native surface owns horizontal scroll restoration when its visible pane scope changes. */
export function createDesktopPaneSurfacePort(scope: string, visible: boolean) {
  return (element: HTMLElement | null) => {
    if (!element || !visible || surfaceScopes.get(element) === scope) return
    surfaceScopes.set(element, scope)
    element.scrollLeft = 0
    const viewport = element.querySelector<HTMLElement>('[data-testid="desktop-workbench-content"]')
    if (viewport) viewport.scrollLeft = 0
  }
}
