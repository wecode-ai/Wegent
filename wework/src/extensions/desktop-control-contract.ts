export interface DesktopControlCommand {
  id: string
  action: string
  selector: string
  value?: string
  target?: string
  text?: string
  timeoutMs?: number
  enabled?: boolean
  visible?: boolean
  stableMs?: number
  key?: string
  filename?: string
  mimeType?: string
}

export type DesktopControlExtensionResult = { handled: false } | { handled: true; value: string }

export interface DesktopControlExtension {
  execute: (command: DesktopControlCommand) => Promise<DesktopControlExtensionResult>
}
