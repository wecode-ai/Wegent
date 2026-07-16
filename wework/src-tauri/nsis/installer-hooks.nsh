; SPDX-FileCopyrightText: 2025 Weibo, Inc.
;
; SPDX-License-Identifier: Apache-2.0

; Kill sidecar and bundled Codex processes before overwriting their binaries.
; GUI-launched WeWork may leave wegent-executor.exe or codex.exe running,
; which locks files in %LOCALAPPDATA%\WeWork\binaries and breaks the installer.
!macro NSIS_HOOK_PREINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "wegent-executor.exe"
  Pop $R0
  nsis_tauri_utils::KillProcessCurrentUser "codex.exe"
  Pop $R0
  Sleep 500
!macroend
