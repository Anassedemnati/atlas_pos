# Atlas POS: the owner's test guide

A 20-minute morning test on your Mac, then what to try on Windows. The French technician guide (`docs/TECHNICIEN.md`) explains the same product from the installer's point of view; this one is for checking that it works.

## 1. What to run

All packages are in `release/` after `npm run dist:<platform>` (the folder is not in git).

| File | For | How it is built |
|---|---|---|
| `release/AtlasPOS-0.1.0-mac-x64.dmg` | your Mac (Intel) | `npm run dist:mac` |
| `release/AtlasPOS-Setup-0.1.0.exe` | Windows 10/11, 64 bits | `npm run dist:win` (built from the Mac) |
| `release/AtlasPOS-0.1.0-linux-amd64.deb`, `release/AtlasPOS-0.1.0-linux-x86_64.AppImage` | Linux, 64 bits | `npm run dist:linux` |

Nothing is signed in version 1, so each system warns once.

### On the Mac

1. Open the `.dmg` and drag Atlas POS to Applications.
2. First launch: the app is unsigned. Right-click the icon, Open, Open. If macOS only offers "Move to Trash", go to System Settings, Privacy & Security, scroll down and click "Open Anyway". Or from a terminal: `xattr -dr com.apple.quarantine "/Applications/Atlas POS.app"`. (A file copied over from another machine carries the quarantine mark; one built here does not.)
3. The data lives in `~/Library/Application Support/AtlasPOS`. To start from nothing again: quit the app, then `rm -rf ~/Library/Application\ Support/AtlasPOS`.
4. To try without touching that folder, start the app from a terminal on another folder:

```bash
ATLAS_DATA_DIR=/tmp/atlas-try "/Applications/Atlas POS.app/Contents/MacOS/Atlas POS"
```

In the packaged app, a launch starts a small watchdog process which starts the real application; that is normal (see "Power cut" below).

### On Windows

1. Copy the `.exe` to the machine (a real PC or a VM) and double-click it.
2. SmartScreen: "More info", then "Run anyway". Accept the administrator prompt.
3. Keep the default folder, Install, tick "Run Atlas POS". The setup wizard opens.
4. Data is in `C:\ProgramData\AtlasPOS`. Uninstall (Settings, Apps) asks "Supprimer aussi les données ?": the default is No. Try both, once.
5. To wipe the data and start over without uninstalling: quit the app, delete `C:\ProgramData\AtlasPOS` (keep the folder itself, or run the installer again to restore its permissions).

## 2. The setup wizard: values to type

Use the same names as the automated tests, so that what you see matches the end-to-end screenshots.

| Field | Value |
|---|---|
| Business type | Café (or Restaurant for tables) |
| Company | any name; ICE `001234567000012`, IF `12345678`, RC `123456`, Patente `31234567` (the wizard checks the ICE format) |
| Printers | add three **Virtuelle (test)** printers: `Caisse` (role receipt), `Cuisine` (kitchen), `Bar` (bar) |
| Users | Karim, profile Gérant, PIN `1234`, back office login `karim` / password `Atlas-Secret-2026` |
| | Sara, profile Caissier, PIN `2222` |
| | Youssef, profile Serveur, PIN `3333` |
| Technician code | `654321` |
| Backup destination | a folder you create first, for example `~/Desktop/atlas-backup-disk` (kind "Second disque"), press Test: it must go green |
| Autostart and kiosk | **switch both off for a test on your Mac**, otherwise the app starts at every login and takes the whole screen |

If you leave kiosk on by mistake: long-press the logo for 1 second (see below), enter `654321`, tab Quitter, "Quitter vers le bureau".

## 3. What to try

1. **Sell.** Sign in as Sara (`2222`), add a few products, take a cash payment, close. A receipt prints on the virtual printer (next section).
2. **Roles.** Sign in as Youssef (`3333`, waiter) and as Karim (`1234`, manager): the waiter has fewer rights (for example no cancelling a closed ticket and no discount beyond his profile's limit; the technician menu needs the technician code whoever is signed in). The manager can approve what the others may not.
3. **Language.** Tap the user name in the top bar: French, Arabic, English. Arabic flips the whole screen to right-to-left.
4. **Close the day.** The Z closure prints the report and the next sale opens a new day.
5. **Technician menu.** Press the logo in the top-left corner for about one second, enter `654321`. Tabs: Modules, Matériel (test page per printer), Sauvegardes, Profil (export or import an `.atlasprofile`), Journal, Quitter.
6. **Backups.** In the technician menu, Sauvegardes, "Sauvegarder maintenant": a new entry appears, and a `.atlasbak` plus `.json` appear in `AtlasBackup/full/` of your backup folder. Sell something more, then restore the earlier entry: the extra sale is gone, and the database you replaced is kept in `<data>/db/pre-restore-*.db`.
7. **Back office.** See section 6.

## 4. The virtual printer

A virtual printer writes each job as files into the `prints` folder of the data directory:

| Platform | Folder |
|---|---|
| macOS | `~/Library/Application Support/AtlasPOS/prints/` |
| Windows | `C:\ProgramData\AtlasPOS\prints\` |
| Linux | `/var/lib/atlas-pos/prints/` (or `~/.local/share/atlas-pos/prints/`) |

Files are named `<time>-<printer>.bin`, for example `2026-10-23T13-25-51.404Z-caisse.bin`:

- `.bin` is exactly what a real printer would receive (ESC/POS bytes).
- `.png` next to it is a picture of the paper, written when the job is an image (Arabic receipts, or a printer set to "raster") or a document. Open it in Preview. This is the way to check the Arabic receipt.
- `.html` is written for document jobs (invoices).

To read a text receipt without a printer:

```bash
iconv -f CP850 -t UTF-8 "$HOME/Library/Application Support/AtlasPOS/prints/<file>.bin" | tr -d '\000-\010\013-\037'
```

A stray `@` at the start and `V` at the end are the remains of the "initialise" and "cut" commands.

Kitchen and bar tickets go to the `Cuisine` and `Bar` printers according to the category routing. A reprint of a ticket says DUPLICATA.

## 5. Simulate a power cut

A power cut is the process dying with no chance to clean up. The expectation: nothing sold is lost, the open orders come back, and the app tells you so.

1. Sign in, open an order (a table in a restaurant, or a counter order in a café), add three items, do **not** pay.
2. Kill everything, as the power button would:
   - macOS: `pkill -9 -f "Atlas POS"`
   - Windows (as administrator): `taskkill /F /T /IM "Atlas POS.exe"`
   - Linux: `pkill -9 -f atlas-pos`
3. Start the app again. Expected: the recovery screen shows the integrity check, the restored table or order, the time of the last backup and "no ticket lost". Continue, sign in: the order is there with its three lines.
4. Repeat it during a payment, and while a backup runs (Sauvegarder maintenant, then kill at once). The database must always open, with no ticket missing or doubled.

Other things worth killing:

- Only the application, not its watchdog: `pkill -9 -f -- "--child"`. The watchdog starts it again after about a second. Three kills within five minutes put the app in safe mode (nothing prints; the screen offers to restore a backup or restart normally).
- A printer that is not there (a real one unplugged, or a network printer switched off): the receipt stays in the print queue, the printer pill in the top bar changes colour, and the job prints when the printer is back. A job whose outcome is uncertain after a kill asks "à réimprimer ?" instead of printing twice.

## 6. The back office

Where it is: `http://localhost:8080/admin` on the same machine, or `http://<the till's IP address>:8080/admin` from a phone or another computer on the same network (on the Mac: `ipconfig getifaddr en0`). Port 8080 is the wizard's default. It only answers addresses of the local network.

Sign in with the username and password of the manager (`karim` / `Atlas-Secret-2026` if you used the values above). Five wrong passwords lock that account for 15 minutes.

It is served by the running app, so the till must be running. If the page does not load, look for `backoffice.listen_failed` in `<data>/logs/app.log` (port in use).

## 7. Automated checks

```bash
npm run typecheck      # all three TypeScript projects
npm test               # unit and integration tests
npm run e2e            # builds, then Playwright drives the real Electron app on seeded installations
npm run boot-check     # the built app starts on a fresh, a seeded and an unwritable data folder
npm run smoke:linux    # the packaged Linux app in a clean Debian container (needs Docker)
```

The end-to-end tests use the logins of section 2 (Karim `1234`, Sara `2222`, Youssef `3333`, technician code `654321`) and a throwaway data folder each time, so they never touch the data of an app you are testing by hand. Screenshots go to `ATLAS_E2E_SHOTS` (default: a temporary folder).

### The self-test inside the app

`ATLAS_SMOKE=1` makes the app test itself and quit, with no window shown and no person involved:

```bash
env -u ELECTRON_RUN_AS_NODE ATLAS_SMOKE=1 "release/mac/Atlas POS.app/Contents/MacOS/Atlas POS"
```

On a temporary data folder it finishes the setup (café template, one virtual printer), checks that the template photos came out of the package, signs in, sells one product in cash, waits for the receipt to reach the virtual printer, runs a full backup, then prints one line and exits 0:

```
SMOKE_OK 000001 <sha-256 of the backup>
```

On any failure it prints `SMOKE_FAIL <reason>` and the end of the log, and exits 1. `npm run smoke:linux` does the same with the Linux package inside Docker (`debian:stable-slim` with Xvfb); the first run builds a small image, the next ones take a few seconds. Use `SKIP_BUILD=1 npm run smoke:linux` to reuse `release/linux-unpacked`.

## 8. Known limits of these builds

- No code signing (macOS and Windows warn once, see section 1).
- The Windows installer is built from the Mac and has not been run on Windows here: the first real install is the test. What can be checked from the Mac was checked: the NSIS script compiles, the package holds `better-sqlite3` and `serialport` prebuilds for `win32-x64` only, and the template photos are in `resources/templates/media`.
- Real thermal printers, cash drawers and scanners are not part of these tests: the virtual printer proves the bytes, not the hardware.
