$ErrorActionPreference = "Stop"

# The desktop suites exercise the full 1440x960 workbench, like the Linux runner.
# A default 1024x768 Windows display silently clamps Electron's requested bounds.
if (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue) {
  Set-DisplayResolution -Width 1920 -Height 1080 -Force
} else {
  # Set-DisplayResolution ships only with Windows Server. Client SKUs such as
  # the windows-11-arm runner need the user32 display API instead.
  Add-Type -Namespace WeworkE2E -Name NativeDisplay -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public struct DEVMODE {
  [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
  public short dmSpecVersion;
  public short dmDriverVersion;
  public short dmSize;
  public short dmDriverExtra;
  public int dmFields;
  public int dmPositionX;
  public int dmPositionY;
  public int dmDisplayOrientation;
  public int dmDisplayFixedOutput;
  public short dmColor;
  public short dmDuplex;
  public short dmYResolution;
  public short dmTTOption;
  public short dmCollate;
  [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
  public short dmLogPixels;
  public int dmBitsPerPel;
  public int dmPelsWidth;
  public int dmPelsHeight;
  public int dmDisplayFlags;
  public int dmDisplayFrequency;
  public int dmICMMethod;
  public int dmICMIntent;
  public int dmMediaType;
  public int dmDitherType;
  public int dmReserved1;
  public int dmReserved2;
  public int dmPanningWidth;
  public int dmPanningHeight;
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsEx(string lpszDeviceName, ref DEVMODE lpDevMode, System.IntPtr hwnd, int dwflags, System.IntPtr lParam);
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode);
}
'@
  $devmode = New-Object WeworkE2E.NativeDisplay+DEVMODE
  $devmode.dmSize = [short][System.Runtime.InteropServices.Marshal]::SizeOf([type][WeworkE2E.NativeDisplay+DEVMODE])
  # ENUM_CURRENT_SETTINGS = -1
  if (-not [WeworkE2E.NativeDisplay+DEVMODE]::EnumDisplaySettings($null, -1, [ref]$devmode)) {
    throw "Failed to enumerate the current Windows display mode"
  }
  $devmode.dmPelsWidth = 1920
  $devmode.dmPelsHeight = 1080
  # DM_PELSWIDTH | DM_PELSHEIGHT
  $devmode.dmFields = 0x00080000 -bor 0x00100000
  $result = [WeworkE2E.NativeDisplay+DEVMODE]::ChangeDisplaySettingsEx($null, [ref]$devmode, [System.IntPtr]::Zero, 0, [System.IntPtr]::Zero)
  # DISP_CHANGE_SUCCESSFUL = 0
  if ($result -ne 0) {
    throw "Failed to set the Windows display mode to 1920x1080 (ChangeDisplaySettingsEx=$result)"
  }
}
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Write-Host "[windows-e2e-display] work-area=$($bounds.Width)x$($bounds.Height)"
if ($bounds.Width -lt 1440 -or $bounds.Height -lt 960) {
  throw "Windows desktop E2E requires a working area of at least 1440x960"
}
