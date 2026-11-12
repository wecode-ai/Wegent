$ErrorActionPreference = "Stop"

# The desktop suites exercise the full 1440x960 workbench, like the Linux runner.
# A default 1024x768 Windows display silently clamps Electron's requested bounds.
if (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue) {
  Set-DisplayResolution -Width 1920 -Height 1080 -Force
} else {
  # Set-DisplayResolution ships only with Windows Server. Client SKUs such as
  # the windows-11-arm runner need the user32 display API instead.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeworkE2EDisplayMode {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
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
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
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
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE mode, IntPtr hwnd, int flags, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplaySettings(string device, int modeNum, ref DEVMODE mode);
  public static void SetPrimaryResolution(int width, int height) {
    DEVMODE mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    // ENUM_CURRENT_SETTINGS = -1
    if (!EnumDisplaySettings(null, -1, ref mode)) {
      throw new InvalidOperationException("Failed to enumerate the current Windows display mode");
    }
    mode.dmPelsWidth = width;
    mode.dmPelsHeight = height;
    // DM_PELSWIDTH | DM_PELSHEIGHT
    mode.dmFields = 0x00080000 | 0x00100000;
    int result = ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
    // DISP_CHANGE_SUCCESSFUL = 0
    if (result != 0) {
      throw new InvalidOperationException("Failed to set the Windows display mode (ChangeDisplaySettingsEx=" + result + ")");
    }
  }
}
'@
  [WeworkE2EDisplayMode]::SetPrimaryResolution(1920, 1080)
}
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Write-Host "[windows-e2e-display] work-area=$($bounds.Width)x$($bounds.Height)"
if ($bounds.Width -lt 1440 -or $bounds.Height -lt 960) {
  throw "Windows desktop E2E requires a working area of at least 1440x960"
}
