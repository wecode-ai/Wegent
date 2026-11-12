import type { SmartAppInstallation } from './smart-app-manager.js'

export type WorkbenchFlavor = 'lightweight' | 'extended'
export type WorkbenchPresentation = 'window' | 'tab'

export interface WorkbenchInstallation extends SmartAppInstallation {
  flavor: WorkbenchFlavor
  presentation: WorkbenchPresentation
  visible: boolean
  shortcut: string | null
  shortcutError: string | null
}

export interface WorkbenchConfiguration {
  presentation?: WorkbenchPresentation
  resident?: boolean
  background?: boolean
}

/** One installation identity owns its runtime, routes and all presentations. */
export interface WorkbenchService {
  scaffold(input: {
    projectPath: string
    name: string
    displayName: string
    flavor: WorkbenchFlavor
  }): Promise<{ projectPath: string }>
  list(): Promise<WorkbenchInstallation[]>
  install(projectPath: string): Promise<WorkbenchInstallation | null>
  createTodo(): Promise<WorkbenchInstallation | null>
  open(
    id: string,
    presentation?: WorkbenchPresentation,
    activateTab?: boolean
  ): Promise<WorkbenchInstallation>
  hide(id: string): Promise<void>
  stop(id: string): Promise<void>
  remove(id: string): Promise<void>
  createShortcut(id: string): Promise<string>
  setShortcut(id: string, accelerator: string | null): Promise<void>
  configure(id: string, configuration: WorkbenchConfiguration): Promise<WorkbenchInstallation>
}

export function workbenchId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Invalid workbench installation id')
  }
  return value
}

export function parseWorkbenchUrl(value: string): string | null {
  const match = /^wework:\/\/workbenches\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(value)
  return match?.[1] ?? null
}
