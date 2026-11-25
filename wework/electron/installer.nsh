!macro customInstall
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 weworkInstallIncomplete
  IfFileExists "$INSTDIR\resources\app.asar" 0 weworkInstallIncomplete
  IfFileExists "$INSTDIR\resources\wework-launcher.exe" 0 weworkInstallIncomplete
  IfFileExists "$INSTDIR\resources\components.json" 0 weworkInstallIncomplete

  # The installer writes this only after NSIS has extracted the entire package.
  # Each Windows user acknowledges the installation in their own release store.
  ClearErrors
  System::Call 'kernel32::GetSystemTimeAsFileTime(*l .r0)'
  FileOpen $1 "$INSTDIR\wework-installed-release" w
  IfErrors weworkInstallIncomplete
  FileWrite $1 "${VERSION}$\n$0"
  IfErrors weworkInstallWriteFailed
  FileClose $1
  Goto weworkInstallRegistered

  weworkInstallWriteFailed:
    FileClose $1
  weworkInstallIncomplete:
    DetailPrint "Could not register the installed Wework release."
    SetErrorLevel 1
    Quit
  weworkInstallRegistered:
!macroend
