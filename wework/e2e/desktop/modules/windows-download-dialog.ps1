param(
    [int]$AppProcessId,
    [ValidateSet('list', 'save', 'cancel', 'context-menu', 'move-pointer', 'click-pointer')][string]$Action,
    [int]$TimeoutMs = 10000,
    [int]$X,
    [int]$Y
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DownloadDialogInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void MovePointer(int pid, int x, int y) {
    var window = GetForegroundWindow();
    int owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner != pid) throw new InvalidOperationException("The isolated app is not in the foreground");
    var scale = GetDpiForWindow(window) / 96.0;
    var point = new Point { X = (int)Math.Round(x * scale), Y = (int)Math.Round(y * scale) };
    if (!ClientToScreen(window, ref point) || !SetCursorPos(point.X, point.Y))
      throw new InvalidOperationException("Could not move the pointer into the isolated app");
  }
  public static void RightClick(int pid, int x, int y) {
    MovePointer(pid, x, y);
    mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
  }
  public static void LeftClick(int pid, int x, int y) {
    MovePointer(pid, x, y);
    ClickLeftButton();
  }
  public static void ClickDialogButton(IntPtr dialog, int x, int y) {
    var target = WindowFromPoint(new Point { X = x, Y = y });
    if (GetForegroundWindow() != dialog || GetAncestor(target, 2) != dialog)
      throw new InvalidOperationException("The button is not exposed in the foreground download dialog");
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("Could not move the pointer onto the download dialog button");
    ClickLeftButton();
  }
  static void ClickLeftButton() {
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
[void][DownloadDialogInput]::SetThreadDpiAwarenessContext([IntPtr](-4))

if ($Action -eq 'move-pointer') {
    [DownloadDialogInput]::MovePointer($AppProcessId, $X, $Y)
    exit 0
}

if ($Action -eq 'click-pointer') {
    [DownloadDialogInput]::LeftClick($AppProcessId, $X, $Y)
    exit 0
}

function Find-OwnedWindows {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppProcessId)
    $scope = [System.Windows.Automation.TreeScope]::Children
    foreach ($root in [System.Windows.Automation.AutomationElement]::RootElement.FindAll($scope, $condition)) {
        $root
        $root.FindAll($scope, $condition)
    }
}

function Find-SaveDialogs {
    Find-OwnedWindows | Where-Object {
        $window = $_.Current
        $url = $null
        # Electron's download delegate uses the final download URL as the
        # dialog title when setSaveDialogOptions supplies only defaultPath.
        $window.ClassName -eq '#32770' -and
            [DownloadDialogInput]::IsWindowVisible([IntPtr]$window.NativeWindowHandle) -and
            [Uri]::TryCreate($window.Name, [UriKind]::Absolute, [ref]$url) -and
            $url.GetLeftPart([UriPartial]::Authority) -eq $env:WEWORK_E2E_DOWNLOAD_FIXTURE_ORIGIN
    }
}

function Find-ById($Window, [string]$Id, [System.Windows.Automation.ControlType]$ControlType) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    if ($null -ne $ControlType) {
        $typeCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ControlType)
        $condition = [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.Condition[]]@($condition, $typeCondition))
    }
    return $Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Set-SaveFilePath($Dialog, [string]$Path, [DateTime]$Deadline) {
    $editor = Find-ById $Dialog '1001' ([System.Windows.Automation.ControlType]::Edit)
    if ($null -eq $editor) { throw 'Could not find the native Save As filename edit control' }
    $value = $editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $handle = [IntPtr]$Dialog.Current.NativeWindowHandle
    $editor.SetFocus()
    do {
        $focused = $editor.Equals([System.Windows.Automation.AutomationElement]::FocusedElement)
        if ($focused -and [DownloadDialogInput]::GetForegroundWindow() -eq $handle) { break }
        Start-Sleep -Milliseconds 80
    } while ([DateTime]::UtcNow -lt $Deadline)
    if ([DateTime]::UtcNow -ge $Deadline -or
        -not $editor.Equals([System.Windows.Automation.AutomationElement]::FocusedElement) -or
        [DownloadDialogInput]::GetForegroundWindow() -ne $handle) {
        throw 'Could not focus the native Save As filename edit control in the foreground dialog'
    }
    # Enter the path through the dialog's keyboard handling so the shell
    # processes the edit before the Save button is clicked.
    $keys = [regex]::Replace($Path, '[+^%~(){}\[\]]', '{$0}')
    [System.Windows.Forms.SendKeys]::SendWait('{HOME}+{END}' + $keys)
    do {
        $current = $value.Current.Value
        if ($current -eq $Path) { return }
        Start-Sleep -Milliseconds 80
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Native Save As did not accept the requested filename (observed=$([IO.Path]::GetFileName($current)))"
}

if ($Action -eq 'save') { Add-Type -AssemblyName System.Windows.Forms }
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
if ($Action -eq 'list') {
    ConvertTo-Json -Compress -InputObject @(Find-SaveDialogs | ForEach-Object {
        @{ windowId = [string]$_.Current.NativeWindowHandle; title = $_.Current.Name }
    })
    exit 0
}

if ($Action -eq 'context-menu') {
    [DownloadDialogInput]::RightClick($AppProcessId, $X, $Y)
    $kind = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::MenuItem)
    $labels = $env:WEWORK_E2E_DOWNLOAD_MENU_LABELS | ConvertFrom-Json
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($window in Find-OwnedWindows) {
            foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $kind)) {
                if ($item.Current.Name -in $labels -and -not $item.Current.IsOffscreen -and $item.Current.IsEnabled) {
                    $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                    exit 0
                }
            }
        }
        Start-Sleep -Milliseconds 80
    }
    throw 'Could not find the native embedded-browser Save As menu item'
}

$existing = $env:WEWORK_E2E_DOWNLOAD_EXISTING_DIALOGS | ConvertFrom-Json
$dialogState = $null
while ([DateTime]::UtcNow -lt $deadline) {
    $dialogs = @(Find-SaveDialogs | Where-Object { [string]$_.Current.NativeWindowHandle -notin $existing })
    if ($dialogs.Count -gt 1) { throw 'More than one new native Save As dialog was found' }
    if ($dialogs.Count -eq 1) {
        $dialog = $dialogs[0]
        # File list items can share a standard button's AutomationId.
        $buttonId = if ($Action -eq 'save') { '1' } else { '2' }
        $button = Find-ById $dialog $buttonId ([System.Windows.Automation.ControlType]::Button)
        $handle = [IntPtr]$dialog.Current.NativeWindowHandle
        $foreground = [DownloadDialogInput]::GetForegroundWindow() -eq $handle
        $dialogState = "window=$handle foreground=$foreground"
        if ($null -ne $button) {
            $dialogState += " control=$($button.Current.ControlType.ProgrammaticName) enabled=$($button.Current.IsEnabled) offscreen=$($button.Current.IsOffscreen)"
        }
        if ($null -ne $button -and $button.Current.IsEnabled -and -not $button.Current.IsOffscreen -and $foreground) {
            if ($Action -eq 'save') {
                Set-SaveFilePath $dialog $env:WEWORK_E2E_DOWNLOAD_SAVE_PATH $deadline
            }
            $receipt = @{ windowId = [string]$dialog.Current.NativeWindowHandle; title = $dialog.Current.Name }
            $point = $button.GetClickablePoint()
            [DownloadDialogInput]::ClickDialogButton($handle, [int]$point.X, [int]$point.Y)
            do {
                if (-not [DownloadDialogInput]::IsWindowVisible($handle)) {
                    ConvertTo-Json -Compress -InputObject $receipt
                    exit 0
                }
                Start-Sleep -Milliseconds 80
            } while ([DateTime]::UtcNow -lt $deadline)
            throw "The native Save As dialog ${handle} remained visible after clicking its $Action button"
        }
    }
    Start-Sleep -Milliseconds 80
}
if ($dialogState) { throw "The owned native download dialog did not expose a clickable $Action button ($dialogState)" }
throw 'Could not find the owned native Save As dialog'
