; Installer hooks for YandexAmp 2.x (Tauri NSIS bundle).
;
; YandexAmp 1.x was an Electron app installed into the same folder
; (C:\Program Files\YandexAmp) under its own uninstall entry. Installing 2.x on
; top of it would leave two entries in "Apps" and a pile of stale Electron files,
; and uninstalling the old entry later would delete the new app. So before the
; files are copied, the old version is removed quietly.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; electron-builder derives this key from the 1.x appId "ru.yandexamp.app"
!define YAMP1_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\3f678e4e-5e9f-5e07-ae2f-67306bbc9090"

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3

  ReadRegStr $R0 HKLM64 "${YAMP1_KEY}" "UninstallString"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM32 "${YAMP1_KEY}" "UninstallString"
  ${EndIf}
  ${If} $R0 == ""
    ReadRegStr $R0 HKCU "${YAMP1_KEY}" "UninstallString"
  ${EndIf}

  ${If} $R0 != ""
    ; "C:\...\Uninstall YandexAmp.exe" /allusers  ->  C:\...\Uninstall YandexAmp.exe
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 "" 1
      StrCpy $R2 0
      ${Do}
        StrCpy $R1 $R0 1 $R2
        ${If} $R1 == '"'
        ${OrIf} $R1 == ""
          ${ExitDo}
        ${EndIf}
        IntOp $R2 $R2 + 1
      ${Loop}
      StrCpy $R0 $R0 $R2
    ${EndIf}

    ${If} ${FileExists} "$R0"
      ${GetParent} "$R0" $R3
      DetailPrint "Removing YandexAmp 1.x"
      ; _?= runs the uninstaller in place, so ExecWait really waits for it
      ; (otherwise it copies itself to %TEMP% and returns at once)
      ExecWait '"$R0" /allusers /S _?=$R3'
      Delete "$R0"
      RMDir "$R3"
    ${EndIf}
    DeleteRegKey HKLM64 "${YAMP1_KEY}"
    DeleteRegKey HKLM32 "${YAMP1_KEY}"
    DeleteRegKey HKCU "${YAMP1_KEY}"
  ${EndIf}

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
