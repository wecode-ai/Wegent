; Keep the Electron installer on the registry and installation paths used by
; the former Tauri package. The Tauri updater installs this NSIS executable,
; then relaunches the same WeWork.exe path, which now starts Electron.
!define INSTALL_REGISTRY_KEY "Software\you\WeWork"
!define UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WeWork"

!macro preInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" ""
  ${If} $R0 != ""
  ${AndIf} ${FileExists} "$R0\WeWork.exe"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$R0"
  ${EndIf}
!macroend

!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "" "$INSTDIR"
!macroend
