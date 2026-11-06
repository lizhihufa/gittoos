; Uninstall legacy English product name "qingzhi" before installing 青枝.
; Also try to remove leftover LocalAppData folders if uninstallers are gone.

!macro UninstallByProductKey ROOT KEY
  ReadRegStr $R7 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEY}" "UninstallString"
  ReadRegStr $R8 ${ROOT} "Software\${MANUFACTURER}\${KEY}" ""
  ${If} $R7 != ""
    ${If} $R8 == ""
      StrCpy $R8 "$LOCALAPPDATA\${KEY}"
    ${EndIf}
    DetailPrint "Uninstalling previous ${KEY}..."
    ; Prefer in-place silent uninstall so directory can be cleaned
    ExecWait '"$R7" /S _?=$R8' $R9
    Delete "$R8\uninstall.exe"
    RMDir "$R8"
    DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEY}"
    DeleteRegKey ${ROOT} "Software\${MANUFACTURER}\${KEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Legacy ASCII product name from older builds
  !insertmacro UninstallByProductKey HKCU "qingzhi"
  !insertmacro UninstallByProductKey HKLM "qingzhi"

  ; Same Chinese product name left over without going through reinstall page
  !insertmacro UninstallByProductKey HKCU "${PRODUCTNAME}"
  !insertmacro UninstallByProductKey HKLM "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
