import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const TITLE = 'Confirm Core plugin installation'

/** Act as the test user on the real OS dialog; never replace the native decision. */
export async function withNativePluginDecision(control, operation, { allow = true } = {}) {
  const pid = control.applicationProcessId
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'An isolated Electron PID is required')
  await control.command('focusMainWindow', 'body')
  const abort = new AbortController()
  const decision = clickNativeDecision(pid, allow, abort.signal)
  try {
    const [result] = await Promise.all([operation(), decision])
    return result
  } finally {
    abort.abort()
    await decision.catch(() => {})
  }
}

async function clickNativeDecision(pid, allow, signal) {
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
    if ($window.Current.Name -notin @('${TITLE}', 'Core 插件安装确认')) { continue }
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
  const { stdout } = await execute(
    'xdotool',
    [
      'search',
      '--sync',
      '--onlyvisible',
      '--pid',
      String(pid),
      '--name',
      `^(${TITLE}|Core 插件安装确认)$`,
    ],
    options
  )
  const windows = stdout.trim().split(/\s+/)
  assert.equal(windows.length, 1, 'Native plugin confirmation must be unambiguous')
  await execute(
    'xdotool',
    [
      'windowfocus',
      '--sync',
      windows[0],
      'key',
      '--clearmodifiers',
      ...(allow ? ['Tab', 'Return'] : ['Escape']),
    ],
    options
  )
}
