param(
    [int]$AppProcessId,
    [ValidateSet('list', 'save', 'cancel', 'context-menu')][string]$Action,
    [int]$TimeoutMs = 10000,
    [int]$X,
    [int]$Y
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

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
            [Uri]::TryCreate($window.Name, [UriKind]::Absolute, [ref]$url) -and
            $url.GetLeftPart([UriPartial]::Authority) -eq $env:WEWORK_E2E_DOWNLOAD_FIXTURE_ORIGIN
    }
}

function Find-ById($Window, [string]$Id) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    return $Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
if ($Action -eq 'list') {
    ConvertTo-Json -Compress -InputObject @(Find-SaveDialogs | ForEach-Object {
        @{ windowId = [string]$_.Current.NativeWindowHandle; title = $_.Current.Name }
    })
    exit 0
}

if ($Action -eq 'context-menu') {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DownloadMenuPointer {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void RightClick(int pid, int x, int y) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var window = GetForegroundWindow();
    int owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner != pid) throw new InvalidOperationException("The isolated app is not in the foreground");
    var scale = GetDpiForWindow(window) / 96.0;
    var point = new Point { X = (int)Math.Round(x * scale), Y = (int)Math.Round(y * scale) };
    if (!ClientToScreen(window, ref point) || !SetCursorPos(point.X, point.Y))
      throw new InvalidOperationException("Could not move the pointer into the isolated app");
    mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
    [DownloadMenuPointer]::RightClick($AppProcessId, $X, $Y)
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
$foundDialog = $false
while ([DateTime]::UtcNow -lt $deadline) {
    $dialogs = @(Find-SaveDialogs | Where-Object { [string]$_.Current.NativeWindowHandle -notin $existing })
    if ($dialogs.Count -gt 1) { throw 'More than one new native Save As dialog was found' }
    if ($dialogs.Count -eq 1) {
        $foundDialog = $true
        $dialog = $dialogs[0]
        $button = Find-ById $dialog $(if ($Action -eq 'save') { '1' } else { '2' })
        if ($null -ne $button -and $button.Current.IsEnabled) {
            if ($Action -eq 'save') {
                $editor = Find-ById $dialog '1001'
                if ($null -eq $editor) { throw 'Could not find the native Save As filename field' }
                $editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($env:WEWORK_E2E_DOWNLOAD_SAVE_PATH)
            }
            $receipt = @{ windowId = [string]$dialog.Current.NativeWindowHandle; title = $dialog.Current.Name }
            $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            do {
                $stillOpen = @(Find-SaveDialogs | Where-Object { [string]$_.Current.NativeWindowHandle -eq $receipt.windowId })
                if ($stillOpen.Count -eq 0) {
                    ConvertTo-Json -Compress -InputObject $receipt
                    exit 0
                }
                Start-Sleep -Milliseconds 80
            } while ([DateTime]::UtcNow -lt $deadline)
            throw 'The native Save As dialog did not close after its button was invoked'
        }
    }
    Start-Sleep -Milliseconds 80
}
if ($foundDialog) { throw "The owned native download dialog did not expose an enabled $Action button" }
throw 'Could not find the owned native Save As dialog'
