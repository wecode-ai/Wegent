import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  WINDOWS_DECISION_STAGE_DIAGNOSTICS,
  WINDOWS_NATIVE_DECISION_ASSEMBLY,
  windowsNativeWindowDiagnosticScript,
  WINDOWS_NATIVE_DIAGNOSTIC_FIELDS,
  WINDOWS_UIA_STRUCTURE_DIAGNOSTICS,
  WINDOWS_UIA_PROVIDER_DIAGNOSTICS,
} from './native-plugin-window-diagnostics.mjs'

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
    const directory = process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY
    assert.ok(directory, 'The shared runner must prepare the native decision assembly')
    const assembly = join(directory, WINDOWS_NATIVE_DECISION_ASSEMBLY).replaceAll("'", "''")
    const script = `
${WINDOWS_DECISION_STAGE_DIAGNOSTICS}
$targetPid = ${pid}
Write-DecisionStage 'started'
$decisionApartment = [System.Threading.Thread]::CurrentThread.GetApartmentState()
Write-Output ("native-decision-apartment:{0}" -f $decisionApartment)
if ($decisionApartment -ne [System.Threading.ApartmentState]::MTA) {
  throw 'The native decision client requires an MTA thread'
}
Add-Type -AssemblyName UIAutomationClient
Write-DecisionStage 'client-loaded'
Add-Type -AssemblyName UIAutomationTypes
Write-DecisionStage 'types-loaded'
[void][System.Reflection.Assembly]::LoadFrom('${assembly}')
Write-DecisionStage 'native-reader-loaded'
Write-DecisionStage 'provider-register-started'
try {
  $proxyName = [WeworkUiaClient]::RegisterProviders()
} catch {
  Write-DecisionStage 'provider-register-failed'
  Write-DecisionStage ($_.Exception.GetBaseException().TargetSite.Name)
  throw
}
Write-DecisionStage 'provider-registered'
${WINDOWS_UIA_PROVIDER_DIAGNOSTICS}
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$dialogCondition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
  $condition,
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'),
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
))
$expectedTitles = @(${(decision.titles ?? TITLES).map(title => "'" + title.replaceAll("'", "''") + "'").join(', ')})
$allowedButtonNames = @(${decision.labels ? decision.labels.map(label => "'" + label.replaceAll("'", "''") + "'").join(', ') : allow ? "'Allow installation', 'Allow update', '允许安装', '允许更新'" : "'Cancel', '取消'"})
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$iteration = 0
while ([DateTime]::UtcNow -lt $deadline) {
  Write-DecisionStage 'search-started'
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  Write-DecisionStage 'search-completed'
  $decisions = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
  foreach ($ownerWindow in $windows) {
    Write-DecisionStage 'owned-window-present'
    Write-DecisionStage 'owned-dialog-search-started'
    $dialogs = $ownerWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree, $dialogCondition)
    Write-DecisionStage 'owned-dialog-search-completed'
    foreach ($window in $dialogs) {
      Write-DecisionStage 'owned-dialog-present'
      $decisionTitle = $window.Current.Name
      Write-DecisionStage 'title-read'
      if ($decisionTitle -notin $expectedTitles) {
        Write-DecisionStage 'title-unmatched'
        continue
      }
      $decisions.Add($window)
    }
  }
  if ($decisions.Count -gt 1) {
    Write-DecisionStage 'dialog-ambiguous'
    throw 'The isolated app displayed ambiguous native Core plugin decisions'
  }
  if ($decisions.Count -eq 1) {
    $window = $decisions[0]
    Write-DecisionStage 'dialog-matched'
    Write-DecisionStage 'button-search-started'
    $dialogHandle = [IntPtr]$window.Current.NativeWindowHandle
    $buttonHandles = [WeworkNativeDialogStructure]::DialogButtons($dialogHandle, $targetPid)
    $buttons = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
    foreach ($buttonHandle in $buttonHandles) {
      $nativeButton = [System.Windows.Automation.AutomationElement]::FromHandle($buttonHandle)
      Write-DecisionStage 'button-handle-resolved'
      if ($nativeButton.Current.ProcessId -ne $targetPid -or $nativeButton.Current.ControlType.Id -ne [System.Windows.Automation.ControlType]::Button.Id) {
        try {
          Write-Output ("native-decision-structure:uia-button-pid-matches:{0}" -f [int]($nativeButton.Current.ProcessId -eq $targetPid))
          Write-Output ("native-decision-structure:uia-button-type-matches:{0}" -f [int]($nativeButton.Current.ControlType.Id -eq [System.Windows.Automation.ControlType]::Button.Id))
          Write-Output ("native-decision-structure:uia-button-handle-matches:{0}" -f [int]([IntPtr]$nativeButton.Current.NativeWindowHandle -eq $buttonHandle))
          Write-Output ("native-decision-structure:uia-button-control-type-id:{0}" -f $nativeButton.Current.ControlType.Id)
        } catch {
          Write-DecisionStage 'button-identity-diagnostics-failed'
        }
        Read-ButtonProvider $buttonHandle
        throw 'The native Button handle did not expose its owned UIA Button'
      }
      $buttons.Add($nativeButton)
    }
    Write-DecisionStage 'button-search-completed'
    Write-Output ("native-decision-button-count:{0}" -f $buttons.Count)
${WINDOWS_UIA_STRUCTURE_DIAGNOSTICS}
    $matchingButtons = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
    foreach ($button in $buttons) {
      Write-DecisionStage 'button-present'
      Write-DecisionStage 'button-name-read-started'
      $buttonName = $button.Current.Name
      Write-DecisionStage 'button-name-read'
      if ($buttonName -in $allowedButtonNames) {
        $matchingButtons.Add($button)
        continue
      }
      Write-DecisionStage 'button-name-unmatched'
    }
    if ($matchingButtons.Count -gt 1) {
      Write-DecisionStage 'button-ambiguous'
      throw 'The isolated app displayed ambiguous native decision buttons'
    }
    if ($matchingButtons.Count -eq 1) {
      $button = $matchingButtons[0]
      $decisionTitle = $window.Current.Name
      if ($decisionTitle -notin $expectedTitles) {
        throw 'The native dialog title changed before invocation'
      }
      if (-not [WeworkNativeDialogStructure]::OwnedButton($dialogHandle, [IntPtr]$button.Current.NativeWindowHandle, $targetPid)) {
        throw 'The native Button ownership changed before invocation'
      }
      if ($button.Current.Name -notin $allowedButtonNames -or $button.Current.ProcessId -ne $targetPid -or $button.Current.ControlType.Id -ne [System.Windows.Automation.ControlType]::Button.Id) {
        throw 'The selected native Button changed before invocation'
      }
      Write-DecisionStage 'selection-revalidated'
      Write-DecisionStage 'button-matched'
      Write-DecisionStage 'invoke-pattern-read-started'
      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      Write-DecisionStage 'invoke-pattern-read'
      Write-DecisionStage 'invoke-started'
      ${decision.focus ? '$button.SetFocus()' : ''}
      $pattern.Invoke()
      Write-DecisionStage 'invoke-completed'
      exit 0
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
        '-Mta',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      options
    ).catch(async error => {
      const stages = new Set([
        'started',
        'client-loaded',
        'types-loaded',
        'provider-register-started',
        'provider-registered',
        'provider-register-failed',
        'LoadDefaultProxies',
        'native-reader-loaded',
        'search-started',
        'search-completed',
        'owned-window-present',
        'owned-dialog-search-started',
        'owned-dialog-search-completed',
        'title-read',
        'owned-dialog-present',
        'title-unmatched',
        'dialog-matched',
        'dialog-ambiguous',
        'button-search-started',
        'button-search-completed',
        'uia-structure-started',
        'uia-structure-completed',
        'uia-structure-failed',
        'button-present',
        'button-handle-resolved',
        'button-identity-diagnostics-failed',
        'provider-create-started',
        'provider-diagnostics-failed',
        'button-ambiguous',
        'selection-revalidated',
        'button-name-read-started',
        'button-name-read',
        'button-name-unmatched',
        'button-matched',
        'invoke-pattern-read-started',
        'invoke-pattern-read',
        'invoke-started',
        'invoke-completed',
      ])
      const evidence = windowsDecisionEvidence(error.stdout, stages)
      if (!signal.aborted)
        console.error(
          '[native-plugin-decision-failed]',
          JSON.stringify({
            pid,
            allow,
            code: typeof error.code === 'number' ? error.code : null,
            killed: error.killed === true,
            signal: error.signal ?? null,
            ...evidence,
          })
        )
      if (!signal.aborted) await recordWindowsNativeWindowDiagnostics(pid, signal)
      throw error
    })
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

async function recordWindowsNativeWindowDiagnostics(pid, signal) {
  const stages = new Set([
    'observer-started',
    'observer-types-loaded',
    'observer-dialog-matched',
    'observer-dialog-missing',
    'observer-dialog-ambiguous',
    'observer-completed',
    'observer-failed',
  ])
  let output
  let failure = null
  try {
    const result = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Mta',
        '-EncodedCommand',
        Buffer.from(windowsNativeWindowDiagnosticScript(pid, TITLES), 'utf16le').toString('base64'),
      ],
      { timeout: 4_000, signal, encoding: 'utf8' }
    )
    output = result.stdout
  } catch (error) {
    output = error.stdout
    failure = {
      code: typeof error.code === 'number' ? error.code : null,
      killed: error.killed === true,
      signal: error.signal ?? null,
    }
  }
  if (!signal.aborted)
    console.error(
      '[native-plugin-window-diagnostics]',
      JSON.stringify({
        pid,
        platform: 'win32',
        phase: 'after-decision-failure',
        failure,
        ...windowsDecisionEvidence(output, stages),
      })
    )
}

function windowsDecisionEvidence(output, allowedStages) {
  const lines = String(output ?? '').split(/\r?\n/)
  const stageElapsedMs = {}
  let buttonCount = null
  let apartmentState = null
  const emptyButtonDiagnostics = Object.fromEntries(
    WINDOWS_NATIVE_DIAGNOSTIC_FIELDS.map(field => [field, null])
  )
  for (const line of lines) {
    const timing = /^native-decision-timing:([a-zA-Z-]+):(\d+)$/.exec(line)
    if (timing && allowedStages.has(timing[1]) && Number.isSafeInteger(Number(timing[2])))
      stageElapsedMs[timing[1]] = Number(timing[2])
    const count = /^native-decision-button-count:(\d+)$/.exec(line)
    if (count && Number.isSafeInteger(Number(count[1]))) buttonCount = Number(count[1])
    const apartment = /^native-decision-apartment:(MTA|STA|Unknown)$/.exec(line)
    if (apartment) apartmentState = apartment[1]
    const structure = /^native-decision-structure:([a-z0-9-]+):(\d+)$/.exec(line)
    if (
      structure &&
      WINDOWS_NATIVE_DIAGNOSTIC_FIELDS.includes(structure[1]) &&
      Number.isSafeInteger(Number(structure[2])) &&
      (!(structure[1] === 'native-handle-present' || structure[1].endsWith('-matches')) ||
        Number(structure[2]) <= 1)
    )
      emptyButtonDiagnostics[structure[1]] = Number(structure[2])
  }
  return {
    stages: lines
      .filter(line => line.startsWith('native-decision:'))
      .map(line => line.slice('native-decision:'.length))
      .filter(stage => allowedStages.has(stage)),
    stageElapsedMs,
    buttonCount,
    apartmentState,
    emptyButtonDiagnostics,
  }
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
