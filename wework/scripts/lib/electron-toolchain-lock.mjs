import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const electronToolchainLockPath = join(tmpdir(), 'wegent-electron-toolchain.lock')
