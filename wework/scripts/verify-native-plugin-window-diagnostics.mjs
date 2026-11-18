import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { prepareWindowsNativeObserver } from './lib/native-window-observer.mjs'
import { withNativePluginDecision } from '../e2e/desktop/modules/native-plugin-approval.mjs'
import { windowsNativeWindowDiagnosticScript } from '../e2e/desktop/modules/native-plugin-window-diagnostics.mjs'

assert.equal(process.platform, 'win32', 'This verification requires real Windows APIs')
assert.ok(
  process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY,
  'A shared observer output directory is required'
)
await prepareWindowsNativeObserver(process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY)
const script = windowsNativeWindowDiagnosticScript(process.pid, [
  'WEWORK_E2E_READONLY_OBSERVER_NO_DIALOG',
])
const stdout = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Mta',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  { timeout: 4_000, encoding: 'utf8' }
)
for (const stage of ['observer-types-loaded', 'observer-dialog-missing', 'observer-completed'])
  assert.ok(
    stdout.split(/\r?\n/).includes(`native-decision:${stage}`),
    `Missing native stage: ${stage}`
  )
assert.doesNotMatch(stdout, /observer-failed|observer-dialog-matched|native-decision-structure:/)
console.log(
  'Prepared native Win32 diagnostic loaded and enumerated without fabricating a missing dialog'
)

// Own a real OS dialog in a disposable child; never alter another process's controls.
const fixtureScript = `
Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class NativeDecisionFixture {
  private const string Title = "Confirm Core plugin installation";
  private delegate bool WindowVisitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int MessageBox(IntPtr owner, string text, string title, uint type);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowText(IntPtr window, string text);
  private static Thread thread;
  private static int result;
  public static void Start() {
    thread = new Thread(delegate() { result = MessageBox(IntPtr.Zero, "Isolated native driver verification", Title, 0x31); });
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    int ownPid = System.Diagnostics.Process.GetCurrentProcess().Id;
    var clock = System.Diagnostics.Stopwatch.StartNew();
    while (clock.ElapsedMilliseconds < 5000) {
      IntPtr dialog = IntPtr.Zero;
      int matches = 0;
      EnumWindows(delegate(IntPtr window, IntPtr data) {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid != ownPid) return true;
        var title = new StringBuilder(256);
        var kind = new StringBuilder(256);
        GetWindowText(window, title, title.Capacity);
        GetClassName(window, kind, kind.Capacity);
        if (title.ToString() == Title && kind.ToString() == "#32770") { dialog = window; matches++; }
        return true;
      }, IntPtr.Zero);
      if (matches > 1) throw new InvalidOperationException("Ambiguous fixture dialog");
      if (matches == 1) {
        IntPtr allow = GetDlgItem(dialog, 1);
        IntPtr cancel = GetDlgItem(dialog, 2);
        uint allowPid, cancelPid;
        GetWindowThreadProcessId(allow, out allowPid);
        GetWindowThreadProcessId(cancel, out cancelPid);
        if (allow != IntPtr.Zero && cancel != IntPtr.Zero && allowPid == ownPid && cancelPid == ownPid) {
          if (!SetWindowText(allow, "Allow installation") || !SetWindowText(cancel, "Cancel"))
            throw new InvalidOperationException("Cannot label fixture buttons");
          return;
        }
      }
      Thread.Sleep(10);
    }
    throw new InvalidOperationException("Fixture dialog was not ready");
  }
  public static int WaitResult() { thread.Join(); return result; }
}
'@
[NativeDecisionFixture]::Start()
Write-Output 'native-dialog-fixture-ready'
$result = [NativeDecisionFixture]::WaitResult()
Write-Output ("native-dialog-fixture-result:{0}" -f $result)
`

async function verifyDecision(allow) {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Mta',
      '-EncodedCommand',
      Buffer.from(fixtureScript, 'utf16le').toString('base64'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  let ready
  const readiness = new Promise(resolve => {
    ready = resolve
  })
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
    if (stdout.split(/\r?\n/).includes('native-dialog-fixture-ready')) ready()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ error }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const deadline = setTimeout(() => child.kill(), 20_000)
  try {
    await Promise.race([
      readiness,
      completion.then(result => {
        throw new Error(
          'Native fixture exited before readiness: ' + JSON.stringify(result) + stderr
        )
      }),
    ])
    const result = await withNativePluginDecision(
      {
        applicationProcessId: child.pid,
        command: async action => assert.equal(action, 'focusMainWindow'),
      },
      () => completion,
      { allow }
    )
    assert.equal(result.code, 0, stderr)
    assert.equal(result.signal, null)
    assert.ok(
      stdout.split(/\r?\n/).includes('native-dialog-fixture-result:' + (allow ? 1 : 2)),
      'The real dialog must return the selected native result'
    )
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await completion
  }
}

await verifyDecision(true)
await verifyDecision(false)
console.log('Native decision client invoked both Allow and Cancel on owned real Windows dialogs')
