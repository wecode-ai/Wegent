import type { useCollaborationPortalTheme } from './CollaborationTheme'

export function applyCollaborationPortalTheme(
  element: HTMLElement,
  theme: ReturnType<typeof useCollaborationPortalTheme>,
) {
  element.classList.add(...theme.className.split(/\s+/).filter(Boolean))
  if (theme['data-theme'])
    element.setAttribute('data-theme', theme['data-theme'])
  for (const [name, value] of Object.entries(theme.style ?? {})) {
    if (value === null || value === undefined) continue
    element.style.setProperty(
      name.startsWith('--')
        ? name
        : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      String(value),
    )
  }
}
