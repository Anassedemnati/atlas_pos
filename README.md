# Atlas POS

An offline touchscreen point of sale for small businesses in Morocco (restaurants, cafés, bakeries, shops). Electron, React and SQLite; cash, card and mixed payments; ESC/POS receipts and kitchen tickets; automatic backups; a web back office on the local network; French, Arabic (right-to-left) and English.

- Design (binding): `docs/superpowers/specs/2026-10-22-atlas-pos-design.md`
- Technician guide, in French (installation, hardware, backups, restore): `docs/TECHNICIEN.md`
- Owner's test guide (installing the packages, test PINs, virtual printer, power cut): `docs/TESTING.md`

## Requirements

- Node 22.19 or later (`engines` in `package.json`).
- Docker, only for the Linux smoke test.
- No native build tools: `better-sqlite3` and `serialport` ship N-API prebuilds for every platform, so nothing is ever rebuilt (`npmRebuild: false`).

```bash
npm install
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Electron with hot reload (data in the platform's data folder, or `ATLAS_DATA_DIR`) |
| `npm run build` | compiles main, preload and renderer into `out/` |
| `npm run preview` | runs the built app |
| `npm run typecheck` | the three TypeScript projects (main, renderer, tests) |
| `npm test` | unit and integration tests (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | builds, then Playwright drives the real Electron app on seeded installations |
| `npm run boot-check` | the built app boots on a fresh, a seeded and an unwritable data folder |

Some shells (VS Code's terminal among them) export `ELECTRON_RUN_AS_NODE=1`, which turns the Electron binary into plain Node. The npm scripts clear it; if you start Electron by hand, use `env -u ELECTRON_RUN_AS_NODE`.

Set `ATLAS_DATA_DIR=/some/folder` to keep a development database apart from the real one. The default data folder is `C:\ProgramData\AtlasPOS` on Windows, `/var/lib/atlas-pos` (or `~/.local/share/atlas-pos`) on Linux and `~/Library/Application Support/AtlasPOS` on macOS.

## Packages

All of them can be built from a Mac, and land in `release/` (not tracked by git).

| Command | Result |
|---|---|
| `npm run dist:win` | `AtlasPOS-Setup-<version>.exe`: NSIS installer, per machine, data in `C:\ProgramData\AtlasPOS` (`build/installer.nsh` creates it and sets its permissions; the uninstaller asks whether to delete the data) |
| `npm run dist:linux` | `AtlasPOS-<version>-linux-x86_64.AppImage` and `AtlasPOS-<version>-linux-amd64.deb` (the `.deb` creates `/var/lib/atlas-pos`, see `build/linux-postinst.sh`) |
| `npm run dist:mac` | `AtlasPOS-<version>-mac-x64.dmg`, unsigned, for testing |

Configuration is in `electron-builder.yml`. Template product photos are shipped next to the app archive (`extraResources`), and each platform only carries its own native prebuilds. The app icon is `resources/icon.png`, with the `.ico` and `.icns` made from it.

Nothing is code-signed in version 1.

## Smoke test

`ATLAS_SMOKE=1` starts the app on a temporary data folder, finishes the setup (café template, virtual printer), sells and closes one order, runs a backup, prints `SMOKE_OK <ticket label> <backup sha-256>` and exits 0 (`src/main/lifecycle/smoke.ts`).

```bash
npm run smoke:linux             # builds the Linux package, runs it in Docker with Xvfb
SKIP_BUILD=1 npm run smoke:linux  # reuses release/linux-unpacked
```

## Layout

```
src/main/       the main process: domain, application (use cases), infrastructure, interfaces (IPC, HTTP), lifecycle
src/preload/    the sandboxed bridge (CommonJS, dependencies bundled)
src/renderer/   the till, the setup wizard, the technician menu (React) and the back office page
src/shared/     contracts shared by every process: DTOs, IPC channels, permissions, i18n strings
resources/      templates (restaurant, café, bakery, retail) with their photos, and the app icon
build/          installer hooks (NSIS, deb)
scripts/        boot check, test runner, Linux smoke test
tests/          unit, integration and end-to-end tests
docs/           the specification, the guides, the mockups
```
