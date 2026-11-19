import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const WINDOWS_NATIVE_DIAGNOSTIC_FIELDS = [
  'uia-descendants',
  'uia-buttons',
  'uia-button-pid-matches',
  'uia-button-type-matches',
  'uia-button-handle-matches',
  'uia-button-control-type-id',
  'uia-provider-button-factories',
  'uia-provider-created-matches',
  'native-handle-present',
  'native-pid-matches',
  'native-dialog-class-matches',
  'win32-children',
  'win32-buttons',
]

/** Inspect the installed official provider only after identity validation failed. */
export const WINDOWS_UIA_PROVIDER_DIAGNOSTICS = `
function Read-ButtonProvider([IntPtr]$handle) {
  try {
    $proxyAssembly = [System.Reflection.Assembly]::Load($proxyName)
    $proxyType = $proxyAssembly.GetType($proxyName.Name + '.UIAutomationClientSideProviders', $true)
    $proxyTable = $proxyType.GetField('ClientSideProviderDescriptionTable').GetValue($null)
    $factories = @($proxyTable | Where-Object { $_.ClassName -eq 'Button' })
    Write-Output ("native-decision-structure:uia-provider-button-factories:{0}" -f $factories.Count)
    if ($factories.Count -eq 1) {
      Write-DecisionStage 'provider-create-started'
      $proxy = $factories[0].ClientSideProviderFactoryCallback.Invoke($handle, 0, 0)
      Write-Output ("native-decision-structure:uia-provider-created-matches:{0}" -f [int]($null -ne $proxy))
    }
  } catch {
    Write-DecisionStage 'provider-diagnostics-failed'
  }
}
`

/** Capture one lightweight UIA snapshot before the native search can be terminated. */
export const WINDOWS_UIA_STRUCTURE_DIAGNOSTICS = `
if ($buttons.Count -eq 0 -and -not $decisionStages.Contains('uia-structure-started')) {
  Write-DecisionStage 'uia-structure-started'
  try {
    $descendants = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    Write-Output ("native-decision-structure:uia-descendants:{0}" -f $descendants.Count)
    $unfilteredButtons = 0
    foreach ($descendant in $descendants) {
      if ($descendant.Current.ControlType.Id -eq [System.Windows.Automation.ControlType]::Button.Id) { $unfilteredButtons++ }
    }
    Write-Output ("native-decision-structure:uia-buttons:{0}" -f $unfilteredButtons)
    Write-DecisionStage 'uia-structure-completed'
  } catch {
    Write-DecisionStage 'uia-structure-failed'
  }
}
`

export const WINDOWS_DECISION_STAGE_DIAGNOSTICS = `
$decisionStages = [System.Collections.Generic.HashSet[string]]::new()
$decisionClock = [System.Diagnostics.Stopwatch]::StartNew()
function Write-DecisionStage([string]$decisionStage) {
  if ($decisionStages.Add($decisionStage)) {
    Write-Output "native-decision:$decisionStage"
    Write-Output ("native-decision-timing:{0}:{1}" -f $decisionStage, $decisionClock.ElapsedMilliseconds)
  }
}
`

const WINDOWS_NATIVE_DIALOG_INTEROP = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WeworkNativeDialogStructure {
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
  private delegate bool WindowVisitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
`

// A non-inlined CLR registration frame lets official UIA inspect its referenced assembly version.
export const WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE = `${WINDOWS_NATIVE_DIALOG_INTEROP}
  private static bool OwnedWindow(IntPtr window, int expectedPid) {
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    return pid == expectedPid && IsWindow(window);
  }
  private static bool ClassMatches(IntPtr window, string expected) {
    var name = new StringBuilder(256);
    if (GetClassName(window, name, name.Capacity) <= 0)
      throw new InvalidOperationException("Native control class is unavailable");
    return String.Equals(name.ToString(), expected, StringComparison.OrdinalIgnoreCase);
  }
  public static bool OwnedButton(IntPtr dialog, IntPtr button, int expectedPid) {
    return OwnedWindow(dialog, expectedPid) && ClassMatches(dialog, "#32770")
      && OwnedWindow(button, expectedPid) && IsChild(dialog, button)
      && ClassMatches(button, "Button") && IsWindowVisible(button) && IsWindowEnabled(button);
  }
  public static IntPtr[] DialogButtons(IntPtr dialog, int expectedPid) {
    if (!OwnedWindow(dialog, expectedPid) || !ClassMatches(dialog, "#32770"))
      throw new InvalidOperationException("Native dialog ownership changed");
    var matches = new List<IntPtr>();
    bool readable = true;
    EnumChildWindows(dialog, delegate(IntPtr child, IntPtr data) {
      if (!OwnedWindow(child, expectedPid)) return true;
      var name = new StringBuilder(256);
      if (GetClassName(child, name, name.Capacity) <= 0) readable = false;
      else if (String.Equals(name.ToString(), "Button", StringComparison.OrdinalIgnoreCase)
        && IsWindowVisible(child) && IsWindowEnabled(child)) matches.Add(child);
      return true;
    }, IntPtr.Zero);
    if (!readable) throw new InvalidOperationException("Native control classes are unavailable");
    return matches.ToArray();
  }
}
public static class WeworkUiaClient {
  [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
  public static System.Reflection.AssemblyName RegisterProviders() {
    var name = typeof(System.Windows.Automation.AutomationElement).Assembly.GetName();
    name.Name = "UIAutomationClientsideProviders";
    System.Windows.Automation.ClientSettings.RegisterClientSideProviderAssembly(name);
    return name;
  }
}
`

export const WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE = `${WINDOWS_NATIVE_DIALOG_INTEROP}
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  public static int[] FindAndRead(int expectedPid, string[] titles) {
    var matches = new List<IntPtr>();
    bool complete = EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (pid != expectedPid) return true;
      var name = new StringBuilder(256);
      if (GetClassName(window, name, name.Capacity) <= 0 || name.ToString() != "#32770") return true;
      var title = new StringBuilder(512);
      if (GetWindowText(window, title, title.Capacity) <= 0 || Array.IndexOf(titles, title.ToString()) < 0) return true;
      matches.Add(window);
      return true;
    }, IntPtr.Zero);
    if (!complete) throw new InvalidOperationException("Native window enumeration failed");
    if (matches.Count != 1) return new int[] { matches.Count };
    var structure = Read(matches[0], expectedPid);
    var result = new int[structure.Length + 1];
    result[0] = 1;
    Array.Copy(structure, 0, result, 1, structure.Length);
    return result;
  }
  private static int[] Read(IntPtr window, int expectedPid) {
    if (window == IntPtr.Zero) return new int[] { 0, -1, -1, -1, -1 };
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    if (pid == 0 || !IsWindow(window)) return new int[] { 1, -1, -1, -1, -1 };
    if (pid != expectedPid) return new int[] { 1, 0, -1, -1, -1 };
    var parentClass = new StringBuilder(256);
    int dialogClass = GetClassName(window, parentClass, parentClass.Capacity) <= 0 ? -1 : (parentClass.ToString() == "#32770" ? 1 : 0);
    int children = 0, buttons = 0;
    bool classReadsComplete = true;
    EnumChildWindows(window, delegate(IntPtr child, IntPtr data) {
      uint childPid;
      GetWindowThreadProcessId(child, out childPid);
      if (childPid != expectedPid) return true;
      children++;
      var name = new StringBuilder(256);
      if (GetClassName(child, name, name.Capacity) <= 0) classReadsComplete = false;
      else if (String.Equals(name.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) buttons++;
      return true;
    }, IntPtr.Zero);
    GetWindowThreadProcessId(window, out pid);
    if (pid != expectedPid || !IsWindow(window)) return new int[] { 1, -1, -1, -1, -1 };
    return new int[] { 1, 1, dialogClass, children, classReadsComplete ? buttons : -1 };
  }
}
`

export const WINDOWS_NATIVE_DECISION_ASSEMBLY = `native-window-decision-${createHash('sha256').update(WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE).digest('hex')}.dll`

export const WINDOWS_NATIVE_OBSERVER_ASSEMBLY = `native-window-observer-${createHash('sha256').update(WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE).digest('hex')}.dll`

/** Run only after the original input process failed; this observer never sends input. */
export function windowsNativeWindowDiagnosticScript(pid, titles) {
  const directory = process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY
  assert.ok(directory, 'The shared runner must prepare the native window observer assembly')
  const assemblyPath = join(directory, WINDOWS_NATIVE_OBSERVER_ASSEMBLY).replaceAll("'", "''")
  const expectedTitles = titles.map(title => "'" + title.replaceAll("'", "''") + "'").join(', ')
  return `
${WINDOWS_DECISION_STAGE_DIAGNOSTICS}
$targetPid = ${pid}
$expectedTitles = [string[]]@(${expectedTitles})
Write-DecisionStage 'observer-started'
try {
  [void][System.Reflection.Assembly]::LoadFrom('${assemblyPath}')
  Write-DecisionStage 'observer-types-loaded'
  $nativeStructure = [WeworkNativeDialogStructure]::FindAndRead($targetPid, $expectedTitles)
  if ($nativeStructure[0] -eq 1) {
    Write-DecisionStage 'observer-dialog-matched'
    $nativeFields = @('native-handle-present', 'native-pid-matches', 'native-dialog-class-matches', 'win32-children', 'win32-buttons')
    for ($index = 0; $index -lt $nativeFields.Count; $index++) {
      if ($nativeStructure[$index + 1] -ge 0) {
        Write-Output ("native-decision-structure:{0}:{1}" -f $nativeFields[$index], $nativeStructure[$index + 1])
      }
    }
  } elseif ($nativeStructure[0] -eq 0) {
    Write-DecisionStage 'observer-dialog-missing'
  } else {
    Write-DecisionStage 'observer-dialog-ambiguous'
  }
  Write-DecisionStage 'observer-completed'
} catch {
  Write-DecisionStage 'observer-failed'
}
`
}
