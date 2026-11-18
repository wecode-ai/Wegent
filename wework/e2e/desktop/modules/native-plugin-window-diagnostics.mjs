export const WINDOWS_NATIVE_DIAGNOSTIC_FIELDS = [
  'uia-descendants',
  'uia-buttons',
  'native-handle-present',
  'native-pid-matches',
  'native-dialog-class-matches',
  'win32-children',
  'win32-buttons',
]

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

/** Run only after the original input process failed; this observer never sends input. */
export function windowsNativeWindowDiagnosticScript(pid, titles) {
  const expectedTitles = titles.map(title => "'" + title.replaceAll("'", "''") + "'").join(', ')
  return `
${WINDOWS_DECISION_STAGE_DIAGNOSTICS}
$targetPid = ${pid}
$expectedTitles = [string[]]@(${expectedTitles})
Write-DecisionStage 'observer-started'
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WeworkNativeDialogStructure {
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  private delegate bool WindowVisitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
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
'@
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
