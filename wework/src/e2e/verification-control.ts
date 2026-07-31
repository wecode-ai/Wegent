import type {
  DesktopControlCommand,
  DesktopControlExtensionResult,
} from '@/extensions/desktop-control-contract'
import { requestLocalExecutor } from '@/tauri/localExecutor'

interface VerificationControlDependencies {
  elementEnabled: (element: HTMLElement) => boolean
}

function clickAt(
  command: DesktopControlCommand,
  { elementEnabled }: VerificationControlDependencies
): string {
  const coordinates = JSON.parse(command.value ?? '{}') as { x?: number; y?: number }
  if (!Number.isFinite(coordinates.x) || !Number.isFinite(coordinates.y)) {
    throw new Error('clickAt requires finite x and y coordinates')
  }

  let element = document.elementFromPoint(coordinates.x!, coordinates.y!)
  while (element?.shadowRoot) {
    const nested = element.shadowRoot.elementFromPoint(coordinates.x!, coordinates.y!)
    if (!nested || nested === element) break
    element = nested
  }
  const clickable = (element?.closest('button') ?? element) as HTMLElement | null
  if (!clickable) {
    throw new Error(`Unable to find element at ${coordinates.x},${coordinates.y}`)
  }
  if (!elementEnabled(clickable)) {
    throw new Error(`Element at ${coordinates.x},${coordinates.y} is disabled`)
  }

  clickable.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: coordinates.x,
      clientY: coordinates.y,
    })
  )
  return clickable.textContent?.trim() ?? ''
}

async function seedLocalProject(command: DesktopControlCommand): Promise<string> {
  const fixture = JSON.parse(command.value ?? '{}') as {
    name?: string
    path?: string
    projectKey?: string
  }
  if (!fixture.path?.trim()) {
    throw new Error('seedLocalProject requires a workspace path')
  }
  const response = await requestLocalExecutor('runtime.projects.upsert_local', {
    projectKey: fixture.projectKey ?? crypto.randomUUID(),
    name: fixture.name?.trim() || 'AI Verify',
    roots: [fixture.path.trim()],
    runtime: 'codex',
  })
  return JSON.stringify(response)
}

function reloadApp(): string {
  window.setTimeout(() => window.location.reload(), 50)
  return ''
}

export async function executeVerificationControlCommand(
  command: DesktopControlCommand,
  dependencies: VerificationControlDependencies
): Promise<DesktopControlExtensionResult> {
  switch (command.action) {
    case 'clickAt':
      return { handled: true, value: clickAt(command, dependencies) }
    case 'seedLocalProject':
      return { handled: true, value: await seedLocalProject(command) }
    case 'reloadApp':
      return { handled: true, value: reloadApp() }
    default:
      return { handled: false }
  }
}
