; F4-D4: dedicated Tauri Preview cleanup only.
; Never touch the legacy WinForms "ChatGPT To Codex" Run entry.
; Delete our startup value only if it still matches THIS installer path.
!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChatGPT To Codex Tauri Preview"
  StrCmp $0 '"$INSTDIR\chatgpt2codex-desktop.exe"' 0 +2
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChatGPT To Codex Tauri Preview"
!macroend
