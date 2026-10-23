import type { EventBus, Clock } from '../application/ports'
import { createCatalogService, type CatalogService } from '../application/usecases/catalog'
import { createCustomersService, type CustomersService } from '../application/usecases/customers'
import { createDaysService, type DaysService } from '../application/usecases/days'
import { createInvoicesService, type InvoicesService } from '../application/usecases/invoices'
import { createOrdersService, type OrdersService, type SalesDeps } from '../application/usecases/orders'
import { createTicketsService, type TicketsService } from '../application/usecases/tickets'
import { createUsersService, type UsersService } from '../application/usecases/users'
import { createBackupEngine, type BackupEngine } from '../infrastructure/backup/engine'
import { targetsFromDestinations, type BackupTarget } from '../infrastructure/backup/targets'
import { openDatabase, type Database } from '../infrastructure/db/connection'
import { migrate } from '../infrastructure/db/migrate'
import { backupBeforeMigration } from '../infrastructure/db/pre-migration-backup'
import { createSettingsRepo, type SettingsRepo } from '../infrastructure/db/repos/settings-repo'
import { createUsersRepo, type UsersRepo } from '../infrastructure/db/repos/users-repo'
import { createUnitOfWork, type UnitOfWork } from '../infrastructure/db/uow'
import { createPrintService, type PrintService } from '../infrastructure/printing/service'
import type { HtmlPrinter, RenderHtmlToBitmap, RenderHtmlToPdf } from '../infrastructure/printing/types'
import { describeError, type Logger } from '../logger'
import type { DataPaths } from '../paths'

const STOP_WAIT_MS = 10_000
const USB_POLL_MS = 30_000

/** Resolves when `work` does, or after `ms`, whichever comes first. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([work.catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}

/** What the graph is built from: process-wide pieces, and the Electron printing ports. */
export interface ServicesDeps {
  paths: DataPaths
  clock: Clock
  /** One bus for the whole process: the windows stay subscribed across a restore. */
  bus: EventBus
  log: Logger
  appVersion: string
  rasterize: RenderHtmlToBitmap
  htmlPrinter?: HtmlPrinter
  /** HTML to PDF (Electron's `printToPDF`), for invoices saved as files. */
  renderPdf?: RenderHtmlToPdf
}

/** Every use case and engine of an open database. Rebuilt as a whole after a restore: they all hold `db`. */
export interface Services {
  db: Database
  uow: UnitOfWork
  settings: SettingsRepo
  usersRepo: UsersRepo
  users: UsersService
  catalog: CatalogService
  orders: OrdersService
  tickets: TicketsService
  days: DaysService
  customers: CustomersService
  invoices: InvoicesService
  print: PrintService
  backup: BackupEngine
  /** The backup destinations as configured now. */
  targets(): BackupTarget[]
  /**
   * Starts the background work: the print queue (not in safe mode: a job may be what crashed the app),
   * the backup engine, the live backup on each ticket close, and the USB poll that copies what a
   * destination missed (every 30 s). Call it once the till window exists: printing opens hidden windows.
   */
  start(options: { printing: boolean }): void
  /** Stops the background work and waits (10 s at most) for what it is doing. Idempotent. */
  stop(): Promise<void>
}

/**
 * Opens the database for writing, migrates it and builds the use cases on it. Nothing is started:
 * the print queue and the backup engine are started once the till window exists (see `Runtime`).
 * The database is closed again if building fails.
 */
export function openServices(deps: ServicesDeps): Services {
  const { paths, clock, bus, log } = deps
  const db = openDatabase(paths.dbFile)
  try {
    const preMigration = backupBeforeMigration(db, paths, clock)
    if (preMigration) log.info('db.pre_migration_backup', preMigration)
    const migrated = migrate(db)
    if (migrated.from !== migrated.to) log.info('db.migrated', migrated)
    const uow = createUnitOfWork(db, clock, bus)
    const settings = createSettingsRepo(db)
    const users = createUsersService({ db, uow, clock, settings })
    const targets = (): BackupTarget[] => targetsFromDestinations(db)
    const print = createPrintService({
      db,
      settings,
      clock,
      eventBus: bus,
      printsDir: paths.prints,
      rasterize: deps.rasterize,
      ...(deps.htmlPrinter ? { htmlPrinter: deps.htmlPrinter } : {}),
      log: log.info
    })
    const backup = createBackupEngine({ db, paths, targets, clock, settings, log: log.info, eventBus: bus, appVersion: deps.appVersion })
    const sales: SalesDeps = { db, uow, clock, settings, spooler: print.queue, overrides: users, backup }
    let running: (() => void) | null = null
    return {
      db,
      uow,
      settings,
      usersRepo: createUsersRepo(db),
      users,
      catalog: createCatalogService({ db, uow, settings }),
      orders: createOrdersService(sales),
      tickets: createTicketsService(sales),
      days: createDaysService(sales),
      customers: createCustomersService(sales),
      invoices: createInvoicesService({ db, uow, clock, spooler: print.queue, ...(deps.renderPdf ? { renderPdf: deps.renderPdf } : {}) }),
      print,
      backup,
      targets,
      start({ printing }) {
        if (running) return
        const unsubscribe = bus.subscribe('ticket.closed', () => backup.onTicketClosed())
        if (printing) print.queue.start()
        backup.start()
        const poll = setInterval(() => {
          backup.retryPending().catch((error: unknown) => log.error('backup.retry_failed', describeError(error)))
        }, USB_POLL_MS)
        poll.unref?.()
        running = () => {
          unsubscribe()
          clearInterval(poll)
        }
      },
      async stop() {
        running?.()
        running = null
        print.queue.stop()
        backup.stop()
        await within(Promise.all([print.queue.idle(), backup.idle()]), STOP_WAIT_MS)
      }
    }
  } catch (error) {
    db.close()
    throw error
  }
}

