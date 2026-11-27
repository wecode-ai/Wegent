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

export async function clickNativeDecision(pid, allow, signal, evidenceDirectory, decision = {}) {
  const options = { timeout: 12_000, signal, encoding: 'utf8' }
  if (process.platform === 'darwin') {
    await clickMacosNativeDecision(
      pid,
      allow ? ['Allow installation', 'Allow update', '允许安装', '允许更新'] : ['Cancel', '取消'],
      options
    )
    return
  }
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('Native decision stage: assembly-client-start')
Add-Type -AssemblyName UIAutomationClient
[Console]::Error.WriteLine('Native decision stage: assembly-types-start')
Add-Type -AssemblyName UIAutomationTypes
[Console]::Error.WriteLine('Native decision stage: assemblies-ready')
# TaskDialog CCPushButton panes do not expose UIA InvokePattern. Send real pointer input.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NativePluginPointer {
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int X, Y;
    public uint Data, Flags, Time;
    public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Explicit)] struct InputData {
    [FieldOffset(0)] public MouseInput Mouse;
  }
  [StructLayout(LayoutKind.Sequential)] struct Input {
    public uint Type;
    public InputData Data;
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  static Input MouseEvent(uint flags) {
    return new Input { Type = 0, Data = new InputData { Mouse = new MouseInput {
      X = 0, Y = 0, Data = 0, Flags = flags, Time = 0, Extra = UIntPtr.Zero
    } } };
  }
  public static void Click(int window, int x, int y) {
    if (GetForegroundWindow() != new IntPtr(window))
      throw new InvalidOperationException("The isolated native decision is not the foreground window");
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var inputs = new[] { MouseEvent(0x0002), MouseEvent(0x0004) };
    int size = Marshal.SizeOf(typeof(Input));
    uint admitted = SendInput(2, inputs, size);
    if (admitted != 2) {
      int error = Marshal.GetLastWin32Error();
      // Release an admitted press before reporting a partial native input failure.
      if (admitted == 1) SendInput(1, new[] { inputs[1] }, size);
      throw new Win32Exception(error, "The native decision pointer input was not fully admitted");
    }
  }
}
'@

$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$iteration = 0
while ([DateTime]::UtcNow -lt $deadline) {
  $iteration += 1
  [Console]::Error.WriteLine('Native decision stage: root-lookup-start ' + $iteration)
  $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  # UIA exposes Electron's owned modal as a child of its main window.
  # Preserve the isolated process boundary for both levels.
  $windows = @(foreach ($root in $roots) {
    $root
    $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  })
  [Console]::Error.WriteLine('Native decision stage: root-lookup-complete ' + $windows.Count)
  foreach ($window in $windows) {
    [Console]::Error.WriteLine('Native decision stage: window-name-start')
    [Console]::Error.WriteLine('Native decision window: ' + $window.Current.Name)
    if ($iteration -eq 1) {
      [Console]::Error.WriteLine('Native decision stage: window-children-start')
      $children = @($window.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
        @{ name = $_.Current.Name; className = $_.Current.ClassName; controlType = $_.Current.ControlType.ProgrammaticName; processId = $_.Current.ProcessId }
      })
      [Console]::Error.WriteLine('Native decision window children: ' + (ConvertTo-Json -InputObject $children -Compress))
    }
    if ($window.Current.Name -notin @(${(decision.titles ?? TITLES).map(title => `'${title}'`).join(', ')})) { continue }
    [Console]::Error.WriteLine('Native decision stage: button-lookup-start')
    $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    [Console]::Error.WriteLine('Native decision stage: button-lookup-complete ' + $buttons.Count)
    foreach ($button in $buttons) {
      [Console]::Error.WriteLine('Native decision stage: button-name-start')
      [Console]::Error.WriteLine('Native decision element: type=' + $button.Current.ControlType.ProgrammaticName + ' class=' + $button.Current.ClassName)
      if ($button.Current.Name -in @(${decision.labels ? decision.labels.map(label => "'" + label.replaceAll("'", "''") + "'").join(', ') : allow ? "'Allow installation', 'Allow update', '允许安装', '允许更新'" : "'Cancel', '取消'"})) {
        [Console]::Error.WriteLine('Native decision matched label: ' + $button.Current.Name)
        $rectangle = $button.Current.BoundingRectangle
        if ($button.Current.IsOffscreen -or -not $button.Current.IsEnabled -or $rectangle.IsEmpty -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) {
          throw 'The owned native decision control is not clickable'
        }
        ${decision.focus ? '$button.SetFocus()' : ''}
        [Console]::Error.WriteLine('Native decision stage: pointer-start')
        [NativePluginPointer]::Click($window.Current.NativeWindowHandle, [int][Math]::Round($rectangle.X + $rectangle.Width / 2), [int][Math]::Round($rectangle.Y + $rectangle.Height / 2))
        [Console]::Error.WriteLine('Native decision stage: pointer-complete')
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 100
}
$top = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition) | ForEach-Object {
  @{ name = $_.Current.Name; className = $_.Current.ClassName; handle = $_.Current.NativeWindowHandle; processId = $_.Current.ProcessId }
})
[Console]::Error.WriteLine('Native decision top-level windows: ' + (ConvertTo-Json -InputObject $top -Compress))
$diagnostics = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
  $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window
} | Select-Object -First 20 | ForEach-Object {
  @{ name = $_.Current.Name; className = $_.Current.ClassName; handle = $_.Current.NativeWindowHandle; processId = $_.Current.ProcessId }
})
[Console]::Error.WriteLine('Native decision owned windows: ' + (ConvertTo-Json -InputObject $diagnostics -Compress))
throw 'The isolated app did not display its native Core plugin decision'
`
    const startedAt = Date.now()
    try {
      const result = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        options
      )
      console.info('[native-plugin-decision] Windows helper completed', {
        applicationProcessId: pid,
        elapsedMs: Date.now() - startedAt,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    } catch (error) {
      console.error('[native-plugin-decision] Windows helper failed', {
        applicationProcessId: pid,
        elapsedMs: Date.now() - startedAt,
        killed: error.killed,
        signal: error.signal,
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      })
      throw error
    }
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
  await execute('xdotool', ['windowfocus', '--sync', window], { ...options, timeout })
  signal.throwIfAborted()
  const inputTimeout = deadline - Date.now()
  assert.ok(inputTimeout > 0, 'The isolated app did not display its native Core plugin decision')
  // The operation can reject on keydown. Finish keyup before finally aborts the
  // search, or a held Escape/Return can act on the next native dialog.
  await execute(
    'xdotool',
    ['key', '--clearmodifiers', ...(allow ? ['Tab', 'Return'] : ['Escape'])],
    { encoding: 'utf8', timeout: inputTimeout }
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

function isVanishedX11Window(error) {
  return error.code === 1 && /BadWindow \(invalid Window parameter\)/.test(error.stderr ?? '')
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
    let windows = []
    try {
      const { stdout } = await execute(
        'xdotool',
        ['search', '--all', '--sync', '--onlyvisible', '--pid', String(pid)],
        remaining()
      )
      windows = stdout.trim().split(/\s+/).filter(Boolean)
    } catch (error) {
      // X_QueryTree can encounter a disappearing window during PID enumeration.
      if (!isVanishedX11Window(error)) throw error
    }
    // search --name reads only WM_NAME in Ubuntu's xdotool; GTK uses _NET_WM_NAME.
    // getwindowname resolves that EWMH UTF-8 property while preserving PID ownership.
    const titles = await Promise.all(
      windows.map(async window => {
        try {
          const { stdout } = await execute('xdotool', ['getwindowname', window], remaining())
          return { window, title: stdout.trim() }
        } catch (error) {
          // X11 windows can disappear between PID enumeration and property reads.
          if (isVanishedX11Window(error)) return null
          throw error
        }
      })
    )
    const matches = titles
      .filter(value => value && TITLES.includes(value.title))
      .map(value => value.window)
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

/** Click the exact visible native button in one isolated process. */
export async function clickMacosNativeDecision(pid, labels, options) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  await execute(
    '/usr/bin/osascript',
    [
      '-e',
      '\non run argv\n  set targetPid to (item 1 of argv) as integer\n  set acceptedLabels to items 2 thru -1 of argv\n  tell application "System Events"\n    set targetProcess to first application process whose unix id is targetPid\n    repeat 100 times\n      repeat with w in windows of targetProcess\n        set dialogs to sheets of w\n        if subrole of w is "AXDialog" then set end of dialogs to w\n        repeat with dialogReference in dialogs\n        set nativeDialog to contents of dialogReference\n        set nativeElements to get entire contents of nativeDialog\n        repeat with elementReference in nativeElements\n          set nativeElement to contents of elementReference\n          if class of nativeElement is button then\n            set labelText to name of nativeElement\n            if labelText is in acceptedLabels then\n              click nativeElement\n              return\n            end if\n          end if\n        end repeat\n        end repeat\n      end repeat\n      delay 0.1\n    end repeat\n  end tell\n  error "The isolated app did not display its native Core plugin decision"\nend run',
      String(pid),
      ...labels,
    ],
    options
  )
}
