# Building the Chaotic 3D Slicer installer

This produces a single `Chaotic3DSlicer-Setup-x.y.z.exe` you can hand to anyone. On
their PC it installs a tray app that runs the slicing server and lets them slice
from a phone. The app **auto-detects** ElegooSlicer / OrcaSlicer / Bambu Studio
and imports its presets — no manual config.

## Prerequisites (build machine, Windows x64)
- **Node.js 18+** and npm
- **Inno Setup 6** — https://jrsoftware.org/isdl.php (gives you `ISCC.exe` + the GUI compiler)

## One-time
```bat
npm install            REM installs server + electron + electron-builder + node-forge + qrcode
```

## Build the installer
```bat
npm run pack           REM 1) builds the PWA, 2) electron-builder --dir -> dist\win-unpacked\
```
Then compile the Inno script (either way):
```bat
ISCC installer\elegoo-slice.iss
```
or open `installer\elegoo-slice.iss` in the Inno Setup Compiler and press **Compile**.

➡ Output: **`installer\output\Chaotic3DSlicer-Setup-1.0.0.exe`** — distribute that file.

(Bump the version in both `package.json` and the `#define MyAppVersion` line of the `.iss`.)

## What the installer does
- Per-user install (no admin prompt), Start-menu + optional desktop shortcut.
- Optional **"Start with Windows (minimized to tray)"** — adds an autostart entry
  that launches `Chaotic 3D Slicer.exe --tray`.
- Checks for a slicer at install time; if none is found it shows a friendly notice
  with download links (it does **not** block — the app re-checks every launch).

## What the app does on first launch
1. Finds `elegoo-slicer.exe` / `orca-slicer.exe` / `bambu-studio.exe` and the matching
   `%APPDATA%\<Slicer>\user\default` presets, and configures itself.
2. Starts the local server (HTTP `:3000`, trusted-HTTPS `:3443`).
3. Sits in the **system tray** (closing the window hides it there; quit from the
   tray menu) so it's always available for remote slicing.
4. Shows a window with the **phone URL + QR code + certificate** to install.

## Connecting a phone
- **Same Wi-Fi:** install the certificate from `http://<pc-ip>:3000/rootCA.crt`, then
  open `https://<pc-ip>:3443` → browser menu → **Install app** (runs full-screen).
- **Truly remote (any network):** install **Tailscale** on the PC and phone, then use
  the **`https://100.x.x.x:3443`** address shown in the window. The cert already covers
  the Tailscale IP, so it's trusted there too.

## Printer support
- **Centauri Carbon (CC1)** — slice + send over the network (SDCP).
- **Centauri Carbon 2 (CC2)** — slice + send incl. Canvas multi-colour (MQTT).
- **Bambu A1 mini** — slicing works now (its Bambu Studio / Orca presets are detected);
  network send to the A1 is a planned addition (for now, download the gcode and send it
  via Bambu Handy / a USB/SD as usual).
