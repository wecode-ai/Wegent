using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class WeworkE2EOwnedProcess
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern bool CreateProcessW(string executable, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern IntPtr CreateFileW(string path, uint access, uint share,
        IntPtr attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static void Require(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    static IntPtr CreateOwnedJob()
    {
        // The handle must not be inherited: its last close reaps every log-pipe writer.
        var job = CreateJobObjectW(IntPtr.Zero, null);
        Require(job != IntPtr.Zero);
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
        {
            var error = new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(job);
            throw error;
        }
        return job;
    }

    static ProcessInfo StartSuspended(string executable, string commandLine, string directory)
    {
        var input = CreateFileW("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        Require(input != new IntPtr(-1));
        try
        {
            Require(SetHandleInformation(input, 1, 1));
            var startup = new StartupInfo();
            startup.Size = (uint)Marshal.SizeOf<StartupInfo>();
            startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Input = input;
            startup.Output = GetStdHandle(-11);
            startup.Error = GetStdHandle(-12);
            Require(SetHandleInformation(startup.Output, 1, 1));
            Require(SetHandleInformation(startup.Error, 1, 1));
            ProcessInfo process;
            Require(CreateProcessW(executable, new StringBuilder(commandLine), IntPtr.Zero,
                IntPtr.Zero, true, 0x4, IntPtr.Zero, directory, ref startup, out process));
            return process;
        }
        finally { CloseHandle(input); }
    }

    static void WaitForResume(IntPtr owner, string resumePath)
    {
        while (!File.Exists(resumePath))
        {
            var state = WaitForSingleObject(owner, 10);
            Require(state != uint.MaxValue);
            if (state == 0) throw new IOException("Application launch owner exited");
        }
        File.Delete(resumePath);
    }

    public static int Run(string executable, string commandLine, string directory,
        string pidPath, string resumePath, uint ownerProcessId)
    {
        var job = IntPtr.Zero;
        var owner = IntPtr.Zero;
        var process = new ProcessInfo();
        var assigned = false;
        try
        {
            owner = OpenProcess(0x00100000, false, ownerProcessId); // SYNCHRONIZE
            Require(owner != IntPtr.Zero);
            Console.Error.WriteLine("[desktop-e2e-windows-launch] stage=owner-opened");
            job = CreateOwnedJob();
            Console.Error.WriteLine("[desktop-e2e-windows-launch] stage=job-created");
            process = StartSuspended(executable, commandLine, directory);
            Require(AssignProcessToJobObject(job, process.Process));
            assigned = true;
            Console.Error.WriteLine("[desktop-e2e-windows-launch] stage=application-owned");
            File.WriteAllText(pidPath + ".writing", process.ProcessId.ToString(), new UTF8Encoding(false));
            File.Move(pidPath + ".writing", pidPath);
            WaitForResume(owner, resumePath);
            Require(ResumeThread(process.Thread) != uint.MaxValue);
            Console.Error.WriteLine("[desktop-e2e-windows-launch] stage=application-resumed");
            var completed = WaitForMultipleObjects(2, new[] { process.Process, owner }, false, uint.MaxValue);
            Require(completed != uint.MaxValue);
            if (completed == 1) return 1;
            uint code;
            Require(GetExitCodeProcess(process.Process, out code));
            return unchecked((int)code);
        }
        finally
        {
            if (!assigned && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (owner != IntPtr.Zero) CloseHandle(owner);
        }
    }
}
