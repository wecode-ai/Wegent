!macro customInstall
  DetailPrint "Preparing Wework local runtime..."
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --wework-prepare-installation' $0
  StrCmp $0 "0" +2
  DetailPrint "Wework will finish runtime preparation on first launch (code $0)."
!macroend
