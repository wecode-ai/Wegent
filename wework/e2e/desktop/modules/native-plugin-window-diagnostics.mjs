export const WINDOWS_NATIVE_DIAGNOSTIC_FIELDS = [
  'uia-descendants',
  'uia-buttons',
  'native-handle-present',
  'native-pid-matches',
  'native-dialog-class-matches',
  'win32-children',
  'win32-buttons',
]

/** Read only the matched dialog's structure; never log native text or send input. */
export const WINDOWS_EMPTY_BUTTON_DIAGNOSTICS = `
if ($decisions.Count -eq 1 -and $buttons.Count -eq 0) {
  $window = $decisions[0]
  Write-DecisionStage 'empty-button-diagnostics-started'
  try {
    $descendants = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    Write-Output ("native-decision-structure:uia-descendants:{0}" -f $descendants.Count)
    $unfilteredButtons = 0
    foreach ($descendant in $descendants) {
      if ($descendant.Current.ControlType.Id -eq [System.Windows.Automation.ControlType]::Button.Id) { $unfilteredButtons++ }
    }
    Write-Output ("native-decision-structure:uia-buttons:{0}" -f $unfilteredButtons)
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WeworkNativeDialogStructure {
  private delegate bool WindowVisitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  public static int[] Read(IntPtr window, int expectedPid) {
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
    $nativeStructure = [WeworkNativeDialogStructure]::Read([IntPtr]$window.Current.NativeWindowHandle, $targetPid)
    $nativeFields = @('native-handle-present', 'native-pid-matches', 'native-dialog-class-matches', 'win32-children', 'win32-buttons')
    for ($index = 0; $index -lt $nativeFields.Count; $index++) {
      if ($nativeStructure[$index] -ge 0) {
        Write-Output ("native-decision-structure:{0}:{1}" -f $nativeFields[$index], $nativeStructure[$index])
      }
    }
    Write-DecisionStage 'empty-button-diagnostics-completed'
  } catch {
    Write-DecisionStage 'empty-button-diagnostics-failed'
  }
}
`
