# Atlas POS

An offline touchscreen point of sale for small businesses in Morocco: cafés, restaurants, bakeries and shops.
It runs on **one machine in the shop and never needs the internet**. It is built with Electron, React and SQLite.

It handles cash, card and mixed payments, ESC/POS receipts and kitchen/bar tickets, and automatic backups. It also
has a web back office on the local network, and works in French, Arabic (right to left) and English.

This README is for **the next developer**. It explains how to run the project, how the code is organised, how to add
a feature, and how to build the Windows installer (`.exe`) and install it in a new café.

| Document | For whom | What is in it |
|---|---|---|
| `docs/superpowers/specs/2026-10-22-atlas-pos-design.md` | developers | **The specification (binding).** Read sections 1 to 8 before changing behaviour. |
| `docs/superpowers/plans/2026-10-22-atlas-pos-v1.md` | developers | The implementation plan of version 1 |
| `docs/TECHNICIEN.md` (French) | the technician on site | Hardware, installation, setup wizard, backups, restore, troubleshooting |
| `docs/TESTING.md` | anyone testing a build | Test PINs, the virtual printer, simulating a power cut, the self-test |
| `docs/mockups/` | design | The UI mockups the screens follow |

---

## 1. Quick start (10 minutes)

**Requirements**

- **Node 22.19 or later**: the `engines` field in `package.json` sets this. Use `nvm` if you need several Node
  versions.
- **No native build tools.** `better-sqlite3` and `serialport` ship prebuilt N-API binaries for every platform, so
  nothing is ever rebuilt (`npmRebuild: false`).
- **Docker** is only needed for the Linux smoke test.

```bash
git clone https://github.com/Anassedemnati/atlas_pos.git
cd atlas_pos
npm install
ATLAS_DATA_DIR=$PWD/.devdata npm run dev   # a throw-away data folder, kept out of your real one
```

The first launch opens the **setup wizard** (Langue → Type d'activité → Entreprise → Matériel → Utilisateurs →
Sauvegardes):

1. Choose **Café**.
2. Type only a trade name. Every other legal field is optional.
3. Add a **virtual printer**. It writes the printed bytes to files, so no hardware is needed.
4. Create one manager with a PIN and a password.

You land on the PIN login, then on the floor plan.

> **VS Code terminal gotcha.** Some shells export `ELECTRON_RUN_AS_NODE=1`, which turns the Electron binary into plain
> Node. The npm scripts clear it. If you start Electron by hand, use `env -u ELECTRON_RUN_AS_NODE`.

To start over, delete the data folder: `rm -rf .devdata`. The default data folders, used when `ATLAS_DATA_DIR` is not
set, are:

| OS | Data folder |
|---|---|
| Windows | `C:\ProgramData\AtlasPOS` |
| Linux | `/var/lib/atlas-pos`, or `~/.local/share/atlas-pos` |
| macOS | `~/Library/Application Support/AtlasPOS` |

The back office is served on `http://<till IP>:8080`; the port is chosen in the wizard. Sign in with the manager's
username and password from any browser on the same network.

## 2. Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Electron with hot reload |
| `npm run build` | compiles main, preload and renderer into `out/` |
| `npm run preview` | runs the built app |
| `npm run typecheck` | the three TypeScript projects: main, renderer and tests |
| `npm test` | unit and integration tests (Vitest, about 1,300 tests, about 1 minute) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | builds, then Playwright drives the **real Electron app** on fresh installations (about 3 minutes) |
| `npm run boot-check` | the built app boots on a fresh, a seeded and an unwritable data folder |
| `npm run dist:win` / `dist:linux` / `dist:mac` | the installers (see section 7) |

**Before every commit, run `npm run typecheck && npm test`. Also run `npm run e2e` when you touch a screen.**

Screenshots of an e2e run help a lot when you change the UI:

```bash
ATLAS_E2E_SHOTS=/tmp/shots npx playwright test tests/e2e/till.spec.ts         # till screens
WIZARD_SHOTS=/tmp/wizard npx playwright test tests/e2e/setup.spec.ts           # setup wizard screens
```

## 3. How the app is organised

```
src/main/            the Electron main process: the only one that touches SQLite, printers and files
  domain/            pure business rules: order totals, discounts, VAT, templates, settings registry (no I/O)
  application/       use cases, one folder per area: orders, till, tickets, catalog, reports, setup, users...
  infrastructure/    adapters: SQLite repositories and migrations, ESC/POS printing, backups, profiles
  interfaces/ipc/    the IPC handlers the till calls (one file per area)
  interfaces/http/   the LAN back office REST API (Fastify)
  composition/       wiring: builds the services for an open database
  lifecycle/         startup, integrity check, crash recovery, smoke test, media protocol
src/preload/         the sandboxed bridge (window.atlas.invoke)
src/renderer/        React
  features/          till screens: login, floor, order, payment, closure, tickets, setup wizard, technician menu
  backoffice/        the web back office, served over the LAN
  ui/                the shared design-system components (Button, Modal, TextField...)
src/shared/          contracts shared by every process: DTOs, IPC channel schemas (zod), permissions, i18n strings
resources/templates/ the four business templates (JSON) and their product photos (media/<template>/<code>.webp)
build/               installer hooks: NSIS for Windows, postinst for the Linux .deb
scripts/             boot check, test runner, Linux smoke test
tests/               unit/, integration/ (real SQLite), e2e/ (Playwright + Electron), helpers/
```

**Rules that keep the code healthy.** The spec calls these "anti-goals".

- **Business rules live in `src/main/domain` and `src/main/application`, never in a screen.** The till (over IPC) and
  the back office (over HTTP) call the **same use cases**, so they can never disagree.
- **No code per customer.** A café is a *configuration*: its template, its modules (`tables`, `kitchen`, `menus`,
  `customers`, `stock`, `barcode`, `scale`) and its settings. If you need an `if (client === ...)`, add a setting or a
  module instead.
- **Every write goes through a unit of work (`uow.run`)**, which is one SQLite transaction. A closed ticket must
  survive a power cut.
- **Money is integer centimes** (`priceCents`), **VAT is in basis points** (`1000` means 10 %), and **quantities are
  in thousandths** (`qtyMilli`). Prices include VAT (TTC).
- Every input that crosses a process boundary is validated with **zod** (`src/shared/ipc/*.ts`).

### The café flow ("served at the table, paid when leaving")

1. **Table service.** The café template turns on the `tables` module, with two rooms: Salle (12 tables) and Terrasse
   (12 tables).
2. **Ordering.** The waiter taps a table and adds products. The order goes to the bar or kitchen printer according to
   category routing (`printersRouting` in the template).
3. **Addition.** "Addition" prints the pre-bill, and the table turns amber. When the customer leaves, "Encaisser"
   takes the payment and the table becomes free again.
4. **Counter orders.** "Vente directe" opens the counter pad. On a counter order, "Addition" prints the bill and
   **parks** the order, which then waits in the "En attente" list until it is paid.
   - The code is in `src/renderer/features/order/OrderPad.tsx` (`prebill`).
   - The e2e test is `tests/e2e/till.spec.ts`, under "café: served at the table or the counter, paid when leaving".

## 4. Adding or changing a feature: where things go

Follow the existing slices; each area has the same shape. To add an action at the till, for example:

1. **Contract.** Declare the channel in `src/shared/ipc/<area>.ts` with its zod input and its access level:
   `def<OrderDto>()(z.strictObject({ orderId: id }), 'session')`.
2. **Use case.** Add a function in `src/main/application/usecases/<area>/`. It runs inside `uow.run`, checks
   permissions and throws `AppErrorException('<code>')` for business errors. Each error code needs a message in
   `src/shared/i18n/{fr,ar,en}.json`.
3. **Handler.** Add one line in `src/main/interfaces/ipc/<area>.ts`, which calls the use case.
   - If the back office needs the action too, add a route in `src/main/interfaces/http/routes/`.
4. **Screen.** In `src/renderer/features/...`, call it with `api.call('<channel>', input)`.
   - Put the screen's strings in its own `i18n/{fr,ar,en}.json`, in **all three languages**.
5. **Tests.**
   - A unit test for the rule (`tests/unit/`).
   - An integration test for the use case on a real database (`tests/integration/`).
   - An e2e test when a screen changes.
   - `tests/unit/ipc-contract.test.ts` fails if a channel has no handler.

**Database changes.** Add `src/main/infrastructure/db/migrations/00N_<name>.sql`, then register it in
`src/main/infrastructure/db/migrate.ts`; a test fails if you forget.

- Versions have no gaps. Each migration runs in one transaction together with its version bump, and the app takes a
  `pre-migration` backup first.
- **Never edit a migration that has shipped.** Add a new one.

**Settings.** Every setting is declared once in `src/main/domain/config/settings-registry.ts`: its schema, default,
scope and permission. The wizard, the technician menu and the back office all validate against it.

- Example: `business.legal` requires only `nomCommercial`. Many cafés are run under a *patente* with no company, so
  they have no raison sociale, ICE, IF or RC. The other fields are optional, and an empty field is not printed.
  - The wizard repeats this check on screen in `src/renderer/features/setup/steps-config.ts`; keep the two in step.
- **Printing.** Receipt, kitchen, Z report and A4 invoice templates are in
  `src/main/infrastructure/printing/templates/`. The tests decode the ESC/POS bytes back to text, so you can assert on
  what the paper says.

## 5. Business templates, products and photos

Each business type is one file: `resources/templates/{restaurant,cafe,bakery,retail}.json`. It holds:

- the modules, settings, payment methods and staff profiles (`gerant`, `caissier`, `serveur`);
- the categories, products, option groups (`modifierGroups`, with `price_delta_cents` for paid extras) and set menus;
- the rooms and tables;
- the category → printer routing.

The schema is `src/main/domain/config/template.ts`, and `tests/unit/config/template.test.ts` checks every template.

**A template is applied once, at setup.** Changing a template does not change cafés that are already installed; their
catalogue is edited in the back office.

**The café template (version 2)** has 70 Moroccan café products:

| Category | Examples |
|---|---|
| Coffees | noir, double, cassé, crème, nous-nous… |
| Teas | menthe in a glass or a teapot, chiba… |
| Juices | avocat-fruits secs, zaazaa, lait d'amande… |
| Pancakes and flatbreads | msemen, baghrir, harcha, batbout… |
| Snacks | bissara, tacos… |

It also has these option groups and two set menus:

- **Option groups:** coffee preparation, tea herbs, juice options and toppings.
- **Set menus:** "Formule petit-déjeuner" and "Petit-déjeuner marocain".

Photo keys are the default (`ui.keyStyle: "photo"`).

**Product photos.** A product with `"image": true` needs `resources/templates/media/<template>/<code>.webp`. It is
copied to `<data>/media/products/` at setup.

- Format: **512×512 WebP, square, the product on a pure white background**, with no text and no logo.
- Every photo has a **provenance sidecar**, `<code>.webp.json`: `{source, generated, kind, prompt, notes}`. A test
  fails if the file or its sidecar is missing.
- The current café photos are **AI illustrations**. They were generated with the OpenAI image model through the Codex
  CLI (`codex exec`), and their prompts are in the sidecars. They show the *type* of item; a café can replace any
  photo with its own from the back office.
- To add a product photo:
  1. Generate or shoot it, square, on white.
  2. Convert it to 512×512 WebP.
  3. Write the sidecar.
  4. Set `"image": true`.
  5. Run `npx vitest run tests/unit/config/template.test.ts`.

## 6. Tests and checks

| Folder | What | Notes |
|---|---|---|
| `tests/unit/` | pure rules, templates, printing layout, UI helpers | fast |
| `tests/integration/` | use cases on a real SQLite file: orders, closures, backups, crash recovery, HTTP API | uses temporary folders |
| `tests/e2e/` | Playwright starts the built Electron app, runs the setup through IPC, then clicks through the till and the back office | `tests/e2e/helpers.ts` (`startTill('cafe')`, `login`, `addProduct`, `waitForPrint`) |

**Self-test inside the app.** `ATLAS_SMOKE=1` starts the app on a temporary folder and finishes a café setup. It then
sells and closes one order, runs a backup, prints `SMOKE_OK ...` and exits 0. `npm run smoke:linux` does the same with
the Linux package in Docker.

## 7. Building the Windows installer (`.exe`)

```bash
npm install
npm run typecheck && npm test        # never ship a red build
npm run dist:win                     # takes a few minutes; works from macOS too
```

The result is **`release/AtlasPOS-Setup-<version>.exe`**, an NSIS installer for 64-bit Windows, installed per machine.
The `release/` folder is not tracked by git.

- **Bump the version first.** Change `"version"` in `package.json`; it names the file and is shown in the app. An
  update is installed over the previous version and keeps the data.
- `build/installer.nsh` creates `C:\ProgramData\AtlasPOS` and gives the Windows Users group write access to it. On
  uninstall, it asks before deleting the data; the default answer is *No*.
- Configuration is in `electron-builder.yml`. The template photos are shipped beside the app archive
  (`extraResources`), and only the Windows native binaries are included.
- **Not code-signed.** Windows SmartScreen warns once: click "Informations complémentaires", then "Exécuter quand
  même". Code signing is the first thing to add before a wide rollout.
- Linux packages: `npm run dist:linux` builds an AppImage and a `.deb`. The macOS build (`npm run dist:mac`) is for
  testing only.

Copy the `.exe` to a USB key. Optionally add a setup profile (`*.atlasprofile`, exported from the technician menu of
a configured till), so the next café of the same kind starts from it.

## 8. Installing in a new café (checklist)

The full French guide for the technician is `docs/TECHNICIEN.md`. In short:

1. **Hardware.**
   - A touchscreen PC: Windows 10/11 64-bit, 4 GB of RAM or more, 1920×1080 ideally.
   - A USB ESC/POS receipt printer with a cash drawer.
   - Optionally a network bar or kitchen printer (TCP 9100).
   - A second disk or a USB key for backups.
2. **Install.** Run `AtlasPOS-Setup-<version>.exe` as an administrator, then launch Atlas POS.
3. **Wizard.**
   - **Langue:** pick the setup, receipt and staff languages.
   - **Type d'activité:** choose **Café**. The floor plan, bar routing and photo catalogue come with it.
   - **Entreprise:** only the **trade name** is required. Fill in the patente, ICE and the rest only if the café has
     them; whatever is filled is printed on the tickets.
   - **Matériel:** detect and test each printer, and route the drinks to the bar printer.
   - **Utilisateurs:** at least one manager with a password (for the back office) and a PIN for each waiter.
   - **Sauvegardes:** a second disk or USB key, and a NAS if there is one.
4. **Before you leave.**
   - Sell one test order and print the addition.
   - Cancel the test sale, then run the Z closure.
   - Open the back office from the owner's phone.
   - Edit the floor plan ("Modifier le plan") to match the real tables, and the prices in the back office.

## 9. Known limits and what to do next

These are known and not yet done. Start here when you take over:

- **Windows installer.** The installer is built from a Mac and checked there (the NSIS script compiles, and the
  package carries the right native binaries). Test it on a real Windows till, with real printers and a cash drawer,
  before the first café.
- **Code signing.** Add Windows code signing to remove the SmartScreen warning (`win.certificateFile` in
  `electron-builder.yml`).
- **Floor plan.** On small round tables, the amount on an occupied table spills slightly outside the circle. The
  layout is in `src/renderer/features/floor/FloorPlan.tsx` and `floor.css`.
- **Invoice without ICE.** An A4 invoice can now be made by a business without an ICE. A B2B invoice in Morocco
  normally needs the seller's ICE, so consider a warning when one is created without it.
- **Existing installations** keep the café template they were installed with. There is no "update my catalogue from
  the new template" action yet.
- **Out of scope for v1** (see the spec, section 3):
  - licensing;
  - the cloud and multi-shop;
  - integrated card terminals;
  - serial scale protocols (weights are typed in);
  - loyalty, delivery platforms, kitchen display screens and handhelds.

## 10. Git and contributions

- `main` is the shipping branch. Work on a branch, then open a pull request.
- Commit messages follow `type(scope): what changed for the user`, for example
  `feat(cafe): served at the table, paid when leaving`.
- Never commit `release/`, `out/`, `node_modules/` or a data folder.
