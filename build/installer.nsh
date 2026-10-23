; Atlas POS NSIS hooks (included by electron-builder through nsis.include).
; The installation is per machine; the data (database, backups, logs) lives outside the program folder, in
; C:\ProgramData\AtlasPOS, so that every Windows user of the till machine reaches the same data and an
; uninstall or an update never takes it away by accident.

!macro customInstall
  ReadEnvStr $0 "ProgramData"
  ${If} $0 == ""
    StrCpy $0 "C:\ProgramData"
  ${EndIf}
  CreateDirectory "$0\AtlasPOS"
  ; *S-1-5-32-545 = BUILTIN\Users (works on every Windows language): modify, inherited by files and sub-folders.
  nsExec::ExecToLog 'icacls "$0\AtlasPOS" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'
  Pop $1
!macroend

!macro customUnInstall
  ; Not during an update (the new installer removes the previous version silently): the data always stays.
  ${ifNot} ${isUpdated}
    ReadEnvStr $0 "ProgramData"
    ${If} $0 == ""
      StrCpy $0 "C:\ProgramData"
    ${EndIf}
    ; Default answer No; a silent uninstall (/S) also keeps the data.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Supprimer aussi les données (ventes, base de données, sauvegardes locales) ?$\r$\n$\r$\n$0\AtlasPOS" /SD IDNO IDNO atlasKeepData
      RMDir /r "$0\AtlasPOS"
    atlasKeepData:
  ${endIf}
!macroend
