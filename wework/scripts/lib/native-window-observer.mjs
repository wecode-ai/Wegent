import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE,
  WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE,
  WINDOWS_NATIVE_DECISION_ASSEMBLY,
  WINDOWS_NATIVE_OBSERVER_ASSEMBLY,
} from '../../e2e/desktop/modules/native-plugin-window-diagnostics.mjs'

/** Compile once during shared preparation, never inside the bounded observation. */
export async function prepareWindowsNativeObserver(directory) {
  await mkdir(directory, { recursive: true })
  for (const [source, assembly, references] of [
    [WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE, WINDOWS_NATIVE_OBSERVER_ASSEMBLY, ''],
    [
      WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE,
      WINDOWS_NATIVE_DECISION_ASSEMBLY,
      '-ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location)',
    ],
  ]) {
    const assemblyPath = join(directory, assembly)
    const script = `
$ErrorActionPreference = 'Stop'
${references ? 'Add-Type -AssemblyName UIAutomationClient' : ''}
Add-Type ${references} -TypeDefinition @'
${source}
'@ -OutputAssembly '${assemblyPath.replaceAll("'", "''")}' -OutputType Library
`
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', timeout: 30_000 }
    )
    await access(assemblyPath)
  }
}

export async function requireWindowsNativeObserver(directory) {
  await access(join(directory, WINDOWS_NATIVE_OBSERVER_ASSEMBLY))
  await access(join(directory, WINDOWS_NATIVE_DECISION_ASSEMBLY))
}
