export const WORKBENCH_NATIVE_CAPABILITIES = [
  'notifications',
  'clipboard.read',
  'clipboard.write',
  'files.read',
  'files.write',
  'external.open',
] as const

export type WorkbenchNativeCapability = (typeof WORKBENCH_NATIVE_CAPABILITIES)[number]

export function workbenchMethodCapability(method: string): WorkbenchNativeCapability | null {
  if (method === 'notifications.show') return 'notifications'
  const capabilities: Record<string, WorkbenchNativeCapability> = {
    'clipboard.readText': 'clipboard.read',
    'clipboard.writeText': 'clipboard.write',
    'files.openText': 'files.read',
    'files.saveText': 'files.write',
    'external.open': 'external.open',
  }
  return capabilities[method] ?? null
}
