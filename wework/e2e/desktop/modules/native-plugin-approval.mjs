import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const TITLES = [
  'Confirm Core plugin installation',
  'Confirm Core plugin update',
  'Core 插件安装确认',
  'Core 插件更新确认',
]
let decisionSequence = 0

/** Act as the test user on the real OS dialog; never replace the native decision. */
export async function withNativePluginDecision(control, operation, { allow = true } = {}) {
  const pid = control.applicationProcessId
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'An isolated Electron PID is required')
  await control.command('focusMainWindow', 'body')
  const abort = new AbortController()
  const decision = clickNativeDecision(pid, allow, abort.signal, control.matrixEvidenceDirectory)
  try {
    const [result] = await Promise.all([operation(), decision])
    return result
  } finally {
    abort.abort()
    await decision.catch(() => {})
  }
}

async function clickNativeDecision(pid, allow, signal, evidenceDirectory) {
  const options = { timeout: 12_000, signal, encoding: 'utf8' }
  if (process.platform === 'darwin') {
    await execute(
      '/usr/bin/osascript',
      [
        '-e',
        `
on run argv
  set targetPid to (item 1 of argv) as integer
  set allowInstall to (item 2 of argv) is "true"
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    repeat 100 times
      repeat with w in windows of targetProcess
        set dialogs to sheets of w
        if subrole of w is "AXDialog" then set end of dialogs to w
        repeat with dialogReference in dialogs
        set nativeDialog to contents of dialogReference
        set nativeElements to get entire contents of nativeDialog
        repeat with elementReference in nativeElements
          set nativeElement to contents of elementReference
          if class of nativeElement is button then
            set labelText to name of nativeElement
            if (allowInstall and labelText is in {"Allow installation", "Allow update", "允许安装", "允许更新"}) or (not allowInstall and labelText is in {"Cancel", "取消"}) then
              click nativeElement
              return
            end if
          end if
        end repeat
        end repeat
      end repeat
      delay 0.1
    end repeat
  end tell
  error "The isolated app did not display its native Core plugin decision"
end run`,
        String(pid),
        String(allow),
      ],
      options
    )
    return
  }
  if (process.platform === 'win32') {
    const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    if ($window.Current.Name -notin @(${TITLES.map(title => `'${title}'`).join(', ')})) { continue }
    $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($button in $buttons) {
      if ($button.Current.Name -in @(${allow ? "'Allow installation', 'Allow update', '允许安装', '允许更新'" : "'Cancel', '取消'"})) {
        $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 100
}
throw 'The isolated app did not display its native Core plugin decision'
`
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      options
    )
    return
  }
  // X11 keyboard input targets only this process's named modal. Cancel is the default.
  const deadline = Date.now() + options.timeout
  const window = await findLinuxModal(pid, options).catch(async error => {
    if (!signal.aborted) await recordNativeWindowDiagnostics(pid)
    throw error
  })
  await recordNativeDecisionDiagnostics(pid, window, allow, evidenceDirectory, {
    ...options,
    timeout: Math.max(1, deadline - Date.now()),
  })
  const timeout = deadline - Date.now()
  assert.ok(timeout > 0, 'The isolated app did not display its native Core plugin decision')
  await execute(
    'xdotool',
    [
      'windowfocus',
      '--sync',
      window,
      'key',
      '--clearmodifiers',
      ...(allow ? ['Tab', 'Return'] : ['Escape']),
    ],
    { ...options, timeout }
  )
}

async function recordNativeDecisionDiagnostics(pid, window, allow, directory, options) {
  if (!directory) return
  const screenshot = join(directory, `native-plugin-decision-${++decisionSequence}.png`)
  const diagnosticOptions = { ...options, timeout: Math.min(2_000, options.timeout) }
  const [focus, image, accessibility, registryPackage] = await Promise.allSettled([
    execute('xdotool', ['getwindowfocus'], diagnosticOptions),
    execute('import', ['-window', window, screenshot], diagnosticOptions),
    execute(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.a11y.Bus',
        '--object-path',
        '/org/a11y/bus',
        '--method',
        'org.a11y.Bus.GetAddress',
      ],
      diagnosticOptions
    ),
    execute('dpkg-query', ['-W', '-f=${db:Status-Status}', 'at-spi2-core'], diagnosticOptions),
  ])
  console.log(
    '[native-plugin-decision]',
    JSON.stringify({
      pid,
      window,
      allow,
      focus: focus.status === 'fulfilled' ? focus.value.stdout.trim() : null,
      screenshot: image.status === 'fulfilled' ? screenshot : null,
      accessibilityBusAvailable: accessibility.status === 'fulfilled',
      accessibilityRegistryInstalled:
        registryPackage.status === 'fulfilled' &&
        registryPackage.value.stdout.trim() === 'installed',
    })
  )
}

async function findLinuxModal(pid, options) {
  const deadline = Date.now() + options.timeout
  const remaining = () => {
    options.signal.throwIfAborted()
    const timeout = deadline - Date.now()
    assert.ok(timeout > 0, 'The isolated app did not display its native Core plugin decision')
    return { ...options, timeout }
  }
  while (Date.now() < deadline) {
    const { stdout } = await execute(
      'xdotool',
      ['search', '--all', '--sync', '--onlyvisible', '--pid', String(pid)],
      remaining()
    )
    const windows = stdout.trim().split(/\s+/).filter(Boolean)
    // search --name reads only WM_NAME in Ubuntu's xdotool; GTK uses _NET_WM_NAME.
    // getwindowname resolves that EWMH UTF-8 property while preserving PID ownership.
    const titles = await Promise.all(
      windows.map(window => execute('xdotool', ['getwindowname', window], remaining()))
    )
    const matches = windows.filter((_, index) => TITLES.includes(titles[index].stdout.trim()))
    assert.ok(matches.length < 2, 'Native plugin confirmation must be unambiguous')
    if (matches.length === 1 && Date.now() < deadline) return matches[0]
    const wait = deadline - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, wait)))
  }
  throw new Error('The isolated app did not display its native Core plugin decision')
}

async function recordNativeWindowDiagnostics(pid) {
  // Capture the real X11 ownership/title properties before fixture cleanup destroys the dialog.
  const options = { timeout: 2_000, encoding: 'utf8' }
  try {
    const { stdout } = await execute('xprop', ['-root', '_NET_CLIENT_LIST'], options)
    const windows = stdout.match(/0x[0-9a-f]+/gi) ?? []
    const properties = await Promise.all(
      windows.map(async window => {
        const { stdout } = await execute(
          'xprop',
          [
            '-id',
            window,
            '_NET_WM_PID',
            '_NET_WM_NAME',
            'WM_NAME',
            'WM_TRANSIENT_FOR',
            '_NET_WM_WINDOW_TYPE',
          ],
          options
        )
        return { window, properties: stdout }
      })
    )
    console.error(
      '[native-plugin-window-diagnostics]',
      JSON.stringify({ pid, windows: properties })
    )
  } catch (error) {
    console.error('[native-plugin-window-diagnostics]', String(error))
  }
}
