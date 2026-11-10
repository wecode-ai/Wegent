import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { buildLauncher } from '../electron/scripts/build-launcher.mjs'
import {
  deployWindowsAppLocalRuntime,
  findWindowsCrtDirectory,
  windowsDllImports,
} from '../electron/scripts/windows-app-local-runtime.mjs'

function peBinary(imports = [], delayImports = []) {
  const bytes = Buffer.alloc(4096)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(0xf0, 0x94)
  bytes.writeUInt16LE(0x20b, 0x98)
  bytes.writeUInt32LE(0xc00, 0x190)
  bytes.writeUInt32LE(0x1000, 0x194)
  bytes.writeUInt32LE(0xc00, 0x198)
  bytes.writeUInt32LE(0x400, 0x19c)
  for (const [names, directory, stride, table, strings, nameOffset] of [
    [imports, 1, 20, 0x400, 0x600, 12],
    [delayImports, 13, 32, 0x500, 0x800, 4],
  ]) {
    bytes.writeUInt32LE(table + 0xc00, 0x98 + 112 + directory * 8)
    bytes.writeUInt32LE((names.length + 1) * stride, 0x98 + 116 + directory * 8)
    names.forEach((name, index) => {
      const entry = table + index * stride
      if (directory === 13) bytes.writeUInt32LE(1, entry)
      bytes.writeUInt32LE(strings + index * 64 + 0xc00, entry + nameOffset)
      bytes.write(name, strings + index * 64)
    })
  }
  return bytes
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wework VC runtime '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'resources')
  const crtDirectory = join(root, 'redist', 'x64', 'Microsoft.VC143.CRT')
  await mkdir(join(resources, 'bin'), { recursive: true })
  await mkdir(crtDirectory, { recursive: true })
  const executor = join(resources, 'bin', 'wegent-executor.exe')
  const launcher = join(resources, 'wework-launcher.exe')
  await writeFile(executor, peBinary(['KERNEL32.dll', 'VCRUNTIME140_1.dll']))
  await writeFile(launcher, peBinary(['VCRUNTIME140.dll']))
  await writeFile(join(crtDirectory, 'VCRUNTIME140.dll'), peBinary(['KERNEL32.dll']))
  await writeFile(join(crtDirectory, 'VCRUNTIME140_1.dll'), peBinary(['VCRUNTIME140.dll']))
  await writeFile(join(crtDirectory, 'MSVCP140.dll'), peBinary())
  return { resources, executables: [executor, launcher], crtDirectory }
}

test('reads normal and delayed x64 imports, including mixed-case runtime names', () => {
  assert.deepEqual(windowsDllImports(peBinary(['KERNEL32.dll'], ['VCRUNTIME140.dll'])), [
    'kernel32.dll',
    'vcruntime140.dll',
  ])
})

test('deploys the complete VC dependency closure beside each consumer, not system DLLs', async t => {
  const options = await fixture(t)
  const files = await deployWindowsAppLocalRuntime(options)
  assert.deepEqual(
    files.map(file => file.path),
    ['bin/vcruntime140_1.dll', 'bin/vcruntime140.dll', 'vcruntime140.dll'].sort((a, b) =>
      a.localeCompare(b)
    )
  )
  assert.deepEqual(
    (await readdir(join(options.resources, 'bin'))).sort(),
    ['vcruntime140.dll', 'vcruntime140_1.dll', 'wegent-executor.exe'].sort()
  )
  assert.deepEqual(
    await readFile(join(options.resources, 'vcruntime140.dll')),
    await readFile(join(options.crtDirectory, 'VCRUNTIME140.dll'))
  )
  assert.ok(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)))
})

test('fails packaging when a transitive runtime DLL is missing', async t => {
  const options = await fixture(t)
  await rm(join(options.crtDirectory, 'VCRUNTIME140.dll'))
  await assert.rejects(
    deployWindowsAppLocalRuntime(options),
    /Required Visual C\+\+ runtime vcruntime140.dll is missing/
  )
})

test('rejects wrong-architecture runtime DLLs instead of shipping an unusable application', async t => {
  const options = await fixture(t)
  const bytes = peBinary()
  bytes.writeUInt16LE(0x14c, 0x84)
  await writeFile(join(options.crtDirectory, 'VCRUNTIME140.dll'), bytes)
  await assert.rejects(deployWindowsAppLocalRuntime(options), /requires an x64 PE binary/)
})

test('locates the official x64 CRT from the active build environment without PATH lookup', async t => {
  const options = await fixture(t)
  const redist = join(options.crtDirectory, '..', '..')
  assert.equal(await findWindowsCrtDirectory({ VCToolsRedistDir: redist }), options.crtDirectory)
  assert.equal(
    await findWindowsCrtDirectory({ WEWORK_VC_REDIST_DIR: options.crtDirectory }),
    options.crtDirectory
  )
  await assert.rejects(findWindowsCrtDirectory({}), /redistributable directory is unavailable/)
})

test('rejects malformed PE input rather than overlooking a runtime dependency', () => {
  assert.throws(() => windowsDllImports(Buffer.alloc(100)), /x64 PE binary/)
  const bytes = peBinary(['VCRUNTIME140.dll'])
  bytes.writeUInt32LE(0xffffff, 0x40c)
  assert.throws(() => windowsDllImports(bytes), /Invalid PE RVA/)
})

test(
  'the Windows loader uses the deployed DLL rather than the system runtime',
  {
    skip:
      process.platform !== 'win32' ? 'Requires the real Windows loader and MSVC toolchain' : false,
  },
  async t => {
    const options = await fixture(t)
    const source = join(options.resources, 'runtime-probe.rs')
    await writeFile(
      source,
      `
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut std::ffi::c_void;
    fn GetModuleFileNameW(module: *mut std::ffi::c_void, path: *mut u16, size: u32) -> u32;
}
fn main() {
    let name: Vec<u16> = "vcruntime140.dll".encode_utf16().chain(Some(0)).collect();
    let mut path = vec![0u16; 32768];
    unsafe {
        let module = GetModuleHandleW(name.as_ptr());
        assert!(!module.is_null(), "VC runtime must be loaded");
        let length = GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32);
        assert!(length > 0);
        println!("{}", String::from_utf16_lossy(&path[..length as usize]));
    }
}
`
    )
    const executable = await buildLauncher(options.resources, 'x86_64-pc-windows-msvc', source)
    const files = await deployWindowsAppLocalRuntime({
      resources: options.resources,
      executables: [executable],
      crtDirectory: await findWindowsCrtDirectory(),
    })
    assert.ok(files.some(file => file.path === 'vcruntime140.dll'))
    const { stdout } = await promisify(execFile)(executable, [], { windowsHide: true })
    assert.equal(
      resolve(stdout.trim()).toLowerCase(),
      resolve(options.resources, 'vcruntime140.dll').toLowerCase()
    )
  }
)
