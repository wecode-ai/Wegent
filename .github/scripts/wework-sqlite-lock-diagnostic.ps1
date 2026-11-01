param([string]$DatabaseDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SQLiteFileProbe {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int ProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME StartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public int ApplicationType; public uint AppStatus; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session,uint flags,StringBuilder key);
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session,uint fileCount,string[] files,uint appCount,IntPtr apps,uint serviceCount,IntPtr services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out]ProcessInfo[] apps,ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string file,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileSizeEx(SafeFileHandle file,out long size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle file,long distance,out long position,uint method);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle file);
  public static object Owners(string[] paths) {
    uint session; int code=RmStartSession(out session,0,new StringBuilder(Guid.NewGuid().ToString("N"),33));
    if(code!=0)return new{code};
    try {
      code=RmRegisterResources(session,(uint)paths.Length,paths,0,IntPtr.Zero,0,IntPtr.Zero); if(code!=0)return new{code};
      uint needed,count=0,reasons=0; code=RmGetList(session,out needed,ref count,null,ref reasons);
      var processes=new ProcessInfo[needed];count=needed;
      if(needed>0)code=RmGetList(session,out needed,ref count,processes,ref reasons);
      return new{code,count,processes};
    }finally{RmEndSession(session);}
  }
  public static object NoOpTruncate(string path) {
    using(var file=CreateFile(path,0x40000000,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
      if(file.IsInvalid)return new{path,stage="open",code=Marshal.GetLastWin32Error()};
      long size,position;if(!GetFileSizeEx(file,out size))return new{path,stage="size",code=Marshal.GetLastWin32Error()};
      if(!SetFilePointerEx(file,size,out position,0))return new{path,stage="seek",code=Marshal.GetLastWin32Error()};
      bool ok=SetEndOfFile(file);return new{path,stage="truncate-current-size",size,ok,code=ok?0:Marshal.GetLastWin32Error()};
    }
  }
}
'@
$paths = @('state_5.sqlite','state_5.sqlite-wal','state_5.sqlite-shm') | ForEach-Object { Join-Path $DatabaseDirectory $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
$result = @{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate)
  owners = [SQLiteFileProbe]::Owners([string[]]$paths)
  truncate = @($paths | ForEach-Object { [SQLiteFileProbe]::NoOpTruncate($_) })
}
$result | ConvertTo-Json -Depth 7 -Compress
