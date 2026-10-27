!macro customRemoveFiles
  ${if} ${isUpdated}
    # Keep the stable launcher and every immutable version until extraction replaces them.
    # Ordinary v2 updates do not run NSIS; it is only the legacy migration bridge.
  ${else}
    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
  ${endif}
!macroend

!macro customInstall
  # The archive contains only an initial seed, never the live update-state.json.
  # Native adoption verifies the installed files before atomically creating a trial.
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --adopt-install "$INSTDIR\initial-update-state.json"'
  Pop $0
  ${if} $0 != "0"
    Abort "Unable to verify the installation. See installer details for the error."
  ${endif}
!macroend
