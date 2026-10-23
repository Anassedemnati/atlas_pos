import { z } from 'zod'
import type { ImportMode, ImportRow, ImportSummary } from '@shared/dto'
import type { Result } from '@shared/result'
import { catalogToRows, ImportRowSchema } from '../../../domain/catalog/import-row'
import { requirePermission, type Session } from '../../../domain/users/session'
import type { CatalogRepo } from '../../../infrastructure/db/repos/catalog-repo'
import type { UnitOfWork } from '../../../infrastructure/db/uow'
import { MAX_IMPORT_ROWS, writeCatalogSheet } from '../../../infrastructure/import/catalog-sheet'
import { AppErrorException } from '../../errors'
import { attemptSync, invalidInput } from '../users/outcome'
import { fieldOf, logChange, parseInput } from './input'
import { applyImport } from './import-apply'

export interface ImportExportUseCases {
  /**
   * Writes the rows of a parsed sheet (`parseCatalogSheet`) into the catalogue: all or nothing, in one
   * transaction. Needs `catalog.manage`. The rows come from a preview screen, so they are validated
   * again: with the same rules as the sheet, no barcode twice, at least one row, at most 5000
   * (`import_too_large`). A refused row is `invalid_input` with `params.field` = `rows.<index>.<field>`
   * and `params.row` = its sheet row. See `applyImport` for `merge` and `replace`. The sheet's `stock` only
   * starts a stock (new product, or one not tracked until now): a tracked product keeps its live quantity.
   */
  applyCatalogImport(session: Session, rows: ImportRow[], mode: ImportMode): Result<ImportSummary>
  /** The products the till shows, as the sheet `parseCatalogSheet` reads (same columns); an XLSX or a UTF-8 CSV with `;`. */
  exportCatalogSheet(format: 'xlsx' | 'csv'): Buffer
}

const ModeSchema = z.enum(['merge', 'replace'])

export function createImportExportUseCases(deps: { repo: CatalogRepo; uow: UnitOfWork }): ImportExportUseCases {
  const { repo, uow } = deps

  function validRows(raw: unknown): ImportRow[] {
    if (Array.isArray(raw) && raw.length > MAX_IMPORT_ROWS) throw new AppErrorException('import_too_large')
    const parsed = z.array(ImportRowSchema).min(1).safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!
      const index = issue.path[0]
      const row = typeof index === 'number' ? (raw as { row?: unknown }[])[index]?.row : undefined
      throw new AppErrorException('invalid_input', {
        field: fieldOf(issue, ['rows']),
        ...(typeof row === 'number' ? { row } : {})
      })
    }
    const barcodes = new Set<string>()
    parsed.data.forEach((row, index) => {
      if (row.barcode === undefined) return
      if (barcodes.has(row.barcode)) throw invalidInput(`rows.${index}.barcode`, 'listed twice')
      barcodes.add(row.barcode)
    })
    return parsed.data
  }

  return {
    applyCatalogImport: (session, rawRows, rawMode) =>
      attemptSync(() => {
        requirePermission(session, 'catalog.manage')
        const rows = validRows(rawRows)
        const mode = parseInput(ModeSchema, rawMode)
        return uow.run((tx) => {
          const summary = applyImport(tx, repo, rows, mode)
          logChange(tx, session, { type: 'catalog.imported', entity: 'catalog', data: { rows: rows.length, ...summary } })
          return summary
        })
      }),

    exportCatalogSheet: (format) =>
      writeCatalogSheet(
        catalogToRows({ categories: repo.listCategories(), products: repo.listProducts() }),
        format === 'csv' ? 'csv' : 'xlsx'
      )
  }
}
