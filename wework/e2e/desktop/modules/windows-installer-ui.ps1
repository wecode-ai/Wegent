param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][ValidateSet('Install', 'Cancel')][string]$Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Launch suspended so every installer descendant belongs to the job before it runs.
# Closing this job terminates only the processes owned by this invocation.
Add-Type -ReferencedAssemblies @(
  'System.dll', 'System.Core.dll',
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location
) -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Automation;

public sealed class NsisProcessJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
    public int cb; public string reserved, desktop, title;
    public int x, y, width, height, charsX, charsY, fill, flags;
    public short show, reservedSize; public IntPtr reservedPointer, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread; public int processId, threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcesses;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
    ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, int size, out int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job, root, interactive;
  public int RootProcessId { get; private set; }

  public NsisProcessJob(string path) {
    ProcessInfo process = new ProcessInfo();
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception();
      ExtendedLimits limits = new ExtendedLimits();
      limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)))
        throw new Win32Exception();
      StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(startup);
      if (!CreateProcess(path, new StringBuilder("\"" + path + "\""), IntPtr.Zero, IntPtr.Zero,
          false, 4, IntPtr.Zero, System.IO.Path.GetDirectoryName(path), ref startup, out process))
        throw new Win32Exception();
      root = process.process; RootProcessId = process.processId;
      if (!AssignProcessToJobObject(job, root)) throw new Win32Exception();
      if (ResumeThread(process.thread) == UInt32.MaxValue) throw new Win32Exception();
    } catch {
      if (root != IntPtr.Zero) TerminateProcess(root, 1);
      Dispose(); throw;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
    }
  }
  public int[] ActiveProcessIds() {
    for (int size = 256; size <= 1048576; size *= 2) {
      IntPtr data = Marshal.AllocHGlobal(size);
      try {
        int length;
        if (!QueryInformationJobObject(job, 3, data, size, out length)) {
          int error = Marshal.GetLastWin32Error();
          if (error == 234) continue;
          throw new Win32Exception(error);
        }
        int count = Marshal.ReadInt32(data, 4);
        int[] ids = new int[count];
        for (int i = 0; i < count; i++) ids[i] = Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt32();
        return ids;
      } finally { Marshal.FreeHGlobal(data); }
    }
    throw new InvalidOperationException("The installer process job is unexpectedly large");
  }
  public uint ExitCode() {
    uint code;
    if (!GetExitCodeProcess(interactive != IntPtr.Zero ? interactive : root, out code))
      throw new Win32Exception();
    return code;
  }
  public void ObserveInteractiveProcess(int processId) {
    if (Array.IndexOf(ActiveProcessIds(), processId) < 0)
      throw new InvalidOperationException("The installer window is outside its process job");
    interactive = OpenProcess(0x1000, false, processId);
    if (interactive == IntPtr.Zero) throw new Win32Exception();
  }
  public static Task BeginInvoke(AutomationElement element) {
    return Task.Run(() => ((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke());
  }
  public void Dispose() {
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (interactive != IntPtr.Zero) { CloseHandle(interactive); interactive = IntPtr.Zero; }
    if (root != IntPtr.Zero) { CloseHandle(root); root = IntPtr.Zero; }
  }
}
'@

$script:installerJob = $null
$script:invocations = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
$script:stage = 'launch'
$stepTimeoutMs = 10000

function Write-Diagnostic([string]$Message) {
  [Console]::Error.WriteLine("[windows-installer-ui] $Message")
}

function Get-OwnedWindows {
  $processIds = @($script:installerJob.ActiveProcessIds())
  if ($processIds.Count -eq 0) { return }
  $conditions = @($processIds | ForEach-Object {
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$_
    )
  })
  $condition = $conditions[0]
  if ($conditions.Count -gt 1) {
    $condition = [System.Windows.Automation.OrCondition]::new(
      [System.Windows.Automation.Condition[]]$conditions
    )
  }
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $condition
  )
  foreach ($window in $windows) {
    if (-not $window.Current.IsOffscreen) { $window }
  }
}

function Get-Controls($Window, [System.Windows.Automation.ControlType]$Type, [string]$Id = '') {
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $Type
  )
  if ($Id) {
    $identifier = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Id
    )
    $condition = [System.Windows.Automation.AndCondition]::new($condition, $identifier)
  }
  foreach ($control in $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
    if (-not $control.Current.IsOffscreen) { $control }
  }
}

function Get-Button($Window, [string]$Id) {
  $buttons = @(Get-Controls $Window ([System.Windows.Automation.ControlType]::Button) $Id)
  if ($buttons.Count -gt 1) { throw "Ambiguous installer button: $Id" }
  if ($buttons.Count -eq 1) { return $buttons[0] }
}

function Assert-EnabledOwnedControl($Control) {
  if (-not $Control -or -not $Control.Current.IsEnabled -or $Control.Current.IsOffscreen) {
    throw 'The requested installer control is missing, hidden, or disabled'
  }
  if (@($script:installerJob.ActiveProcessIds()) -notcontains $Control.Current.ProcessId) {
    throw 'The requested control no longer belongs to the installer process job'
  }
}

function Invoke-Control($Control) {
  Assert-EnabledOwnedControl $Control
  # Invoke may block while a modal confirmation is open; keep observing its actual result.
  $script:invocations.Add([NsisProcessJob]::BeginInvoke($Control))
}

function Wait-ForState([string]$Description, [scriptblock]$Probe, [int]$TimeoutMs = $stepTimeoutMs) {
  $script:stage = $Description
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt $TimeoutMs) {
    try {
      $state = & $Probe
      if ($null -ne $state) { return $state }
    } catch [System.Windows.Automation.ElementNotAvailableException] {
      # A page transition invalidates the old UIA elements; query the owned window again.
    }
    foreach ($invocation in $script:invocations) {
      if ($invocation.IsFaulted) { $invocation.GetAwaiter().GetResult() }
    }
    if (@($script:installerJob.ActiveProcessIds()).Count -eq 0) {
      throw "Installer exited before $Description (exit code $($script:installerJob.ExitCode()))"
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for $Description after ${TimeoutMs}ms"
}

function Invoke-ButtonWhenEnabled($Window, [string]$Id) {
  $button = Wait-ForState "installer button $Id to become enabled" {
    $candidate = Get-Button $Window $Id
    if ($candidate -and $candidate.Current.IsEnabled) { return $candidate }
  }
  Invoke-Control $button
}

function Find-InitialPage {
  foreach ($window in @(Get-OwnedWindows)) {
    $directory = @(Get-Controls $window ([System.Windows.Automation.ControlType]::Edit) '1019')
    if ($directory.Count -eq 1) { return @{ window = $window; directory = $directory[0] } }
    $radios = @(Get-Controls $window ([System.Windows.Automation.ControlType]::RadioButton))
    if ($radios.Count -eq 2) { return @{ window = $window; radios = $radios } }
  }
}

function Write-FailureSummary {
  try {
    $summary = @(foreach ($window in @(Get-OwnedWindows)) {
      $controls = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      @{
        processId = $window.Current.ProcessId; title = $window.Current.Name
        controls = @($controls | Select-Object -First 80 | ForEach-Object {
          @{
            id = $_.Current.AutomationId; type = $_.Current.ControlType.ProgrammaticName
            name = $_.Current.Name; enabled = $_.Current.IsEnabled; offscreen = $_.Current.IsOffscreen
          }
        })
      }
    })
    Write-Diagnostic ($summary | ConvertTo-Json -Depth 5 -Compress)
  } catch { Write-Diagnostic "Could not inspect the owned installer windows: $($_.Exception.Message)" }
}

try {
  $InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
  if (-not [IO.Path]::IsPathRooted($InstallDirectory)) { throw 'InstallDirectory must be absolute' }
  $InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
  $script:installerJob = [NsisProcessJob]::new($InstallerPath)
  Write-Diagnostic "Started installer PID $($script:installerJob.RootProcessId), action=$Action"
  $page = Wait-ForState 'the installation mode or directory page' { Find-InitialPage }
  $script:installerJob.ObserveInteractiveProcess($page.window.Current.ProcessId)
  if ($page.ContainsKey('radios')) {
    $enabled = @($page.radios | Where-Object { $_.Current.IsEnabled })
    if ($enabled.Count -ne 1) { throw 'A standard user must have exactly one available installation mode' }
    $selection = $enabled[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if (-not $selection.Current.IsSelected) { $selection.Select() }
    Invoke-ButtonWhenEnabled $page.window '1'
    $page = Wait-ForState 'the editable installation directory page' {
      $candidate = Find-InitialPage
      if ($candidate -and $candidate.ContainsKey('directory')) { return $candidate }
    }
  }
  Assert-EnabledOwnedControl $page.directory
  $value = $page.directory.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($value.Current.IsReadOnly) { throw 'The installation directory must be editable' }
  $value.SetValue($InstallDirectory)
  $selectedDirectory = $value.Current.Value
  if (-not [string]::Equals($selectedDirectory, $InstallDirectory, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The directory page did not retain the requested path: $selectedDirectory"
  }
  Write-Diagnostic "Directory page selected $selectedDirectory"
  if ($Action -eq 'Cancel') {
    Invoke-ButtonWhenEnabled $page.window '2'
    $script:cancelConfirmed = $false
    $null = Wait-ForState 'installer cancellation and process exit' {
      if (@($script:installerJob.ActiveProcessIds()).Count -eq 0) { return $true }
      if (-not $script:cancelConfirmed) {
        foreach ($window in @(Get-OwnedWindows)) {
          $yes = Get-Button $window '6'
          $no = Get-Button $window '7'
          if ($yes -and $no -and $yes.Current.IsEnabled) {
            Invoke-Control $yes
            $script:cancelConfirmed = $true
            break
          }
        }
      }
    }
    if ($script:installerJob.ExitCode() -ne 1) { throw 'Cancelling NSIS must return user-aborted exit code 1' }
  } else {
    Invoke-ButtonWhenEnabled $page.window '1'
    $finished = Wait-ForState 'installation to reach the finish page' {
      foreach ($window in @(Get-OwnedWindows)) {
        $next = Get-Button $window '1'
        $checks = @(Get-Controls $window ([System.Windows.Automation.ControlType]::CheckBox))
        if ($next -and $next.Current.IsEnabled -and $checks.Count -eq 1) {
          return @{ window = $window; run = $checks[0] }
        }
      }
    } 300000
    Assert-EnabledOwnedControl $finished.run
    $toggle = $finished.run.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) {
      throw 'Run after installation must be unchecked before finishing'
    }
    Invoke-ButtonWhenEnabled $finished.window '1'
    $null = Wait-ForState 'successful installer process exit' {
      if (@($script:installerJob.ActiveProcessIds()).Count -eq 0) { return $true }
    }
    if ($script:installerJob.ExitCode() -ne 0) { throw 'NSIS installation did not exit successfully' }
  }
  @{
    action = $Action; directoryPageVisited = $true
    selectedDirectory = $selectedDirectory; completed = $true
  } | ConvertTo-Json -Compress
} catch {
  Write-Diagnostic "Failed during $script:stage`: $($_.Exception.Message)"
  if ($script:installerJob) { Write-FailureSummary }
  throw
} finally {
  if ($script:installerJob) { $script:installerJob.Dispose() }
}
