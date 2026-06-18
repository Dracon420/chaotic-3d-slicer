; Inno Setup script for Elegoo Slice — builds a Windows installer (setup.exe)
; you can hand to anyone running a Centauri Carbon (CC1/CC2) or Bambu A1 mini.
;
; Build pipeline (see BUILD.md):
;   1) npm install
;   2) npm run pack            -> produces ..\dist\win-unpacked\
;   3) compile this script with Inno Setup (ISCC elegoo-slice.iss) or the GUI
;   Output: installer\output\ElegooSlice-Setup-<ver>.exe
;
; The app auto-detects ElegooSlicer / OrcaSlicer / Bambu Studio on first launch.
; This installer also checks at install time and warns (but doesn't block) if no
; slicer is found, pointing the user to install one.

#define MyAppName "Chaotic 3D Slicer"
#define MyAppVersion "1.3.1"
#define MyAppPublisher "Chaotic 3D"
#define MyAppExe "Chaotic 3D Slicer.exe"
#define SrcDir "..\dist\win-unpacked"

[Setup]
AppId={{8F2A6C10-3E7B-4D5A-9C21-ELEGOOSLICE01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExe}
SetupIconFile=..\build\icon.ico
OutputDir=output
OutputBaseFilename=Chaotic3DSlicer-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
; Per-user install — no admin prompt (matches a tray app that autostarts per user).
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start {#MyAppName} with Windows (runs minimized in the system tray)"; GroupDescription: "Startup:"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Registry]
; Autostart (minimized to tray) for the current user, if chosen.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "{#MyAppName}"; \
  ValueData: """{app}\{#MyAppExe}"" --tray"; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "Launch {#MyAppName} now"; \
  Flags: nowait postinstall skipifsilent

[Code]
// Silently remove any previously installed version so files can be overwritten.
procedure UninstallPreviousVersion();
var UninstStr: String; Code: Integer;
begin
  if RegQueryStringValue(HKCU,
      'Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F2A6C10-3E7B-4D5A-9C21-ELEGOOSLICE01}_is1',
      'UninstallString', UninstStr) then begin
    Exec(RemoveQuotes(UninstStr), '/SILENT /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
end;

function InitializeSetup(): Boolean;
begin
  UninstallPreviousVersion();
  Result := True;
end;

function SlicerInstalled(): Boolean;
var pf, pf86, local: String;
begin
  pf := ExpandConstant('{commonpf}');
  pf86 := ExpandConstant('{commonpf32}');
  local := ExpandConstant('{localappdata}');
  Result :=
    FileExists(pf + '\ElegooSlicer\elegoo-slicer.exe') or
    FileExists(pf + '\OrcaSlicer\orca-slicer.exe') or
    FileExists(pf + '\Bambu Studio\bambu-studio.exe') or
    FileExists(pf + '\BambuStudio\bambu-studio.exe') or
    FileExists(pf86 + '\ElegooSlicer\elegoo-slicer.exe') or
    FileExists(pf86 + '\OrcaSlicer\orca-slicer.exe') or
    FileExists(local + '\Programs\ElegooSlicer\elegoo-slicer.exe') or
    FileExists(local + '\Programs\OrcaSlicer\orca-slicer.exe');
end;

procedure InitializeWizard();
begin
  if not SlicerInstalled() then
    MsgBox('No 3D slicer was detected on this PC.' + #13#10 + #13#10 +
      '{#MyAppName} uses ElegooSlicer (or OrcaSlicer / Bambu Studio) to slice your models. ' +
      'Please install one first:' + #13#10 +
      '  • ElegooSlicer:  https://www.elegoo.com/pages/elegoo-slicer-software' + #13#10 +
      '  • Bambu Studio:  https://bambulab.com/en/download/studio' + #13#10 + #13#10 +
      'You can finish this install now; {#MyAppName} will detect the slicer automatically the next time it starts.',
      mbInformation, MB_OK);
end;
