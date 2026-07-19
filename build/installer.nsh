; Always install into a "YandexAmp" subfolder of whatever directory the user
; picks, and show that appended path in the directory field.
;
; electron-builder already appends the app name at install time (instFilesPre),
; so the final location is correct regardless; this makes it visible on the
; directory page too, right after the user browses to a folder.

!include "LogicLib.nsh"

Function .onVerifyInstDir
  Push $0
  Push $1

  StrLen $0 "\${APP_FILENAME}"
  StrCpy $1 "$INSTDIR" "" -$0        ; last path segment incl. leading slash

  ${If} $1 != "\${APP_FILENAME}"     ; not already ending with our folder
  ${AndIf} ${FileExists} "$INSTDIR\*.*"  ; a real, existing dir (i.e. from Browse)
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}

  Pop $1
  Pop $0
FunctionEnd
