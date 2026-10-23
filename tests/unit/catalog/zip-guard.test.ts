import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { parseCatalogSheet } from '../../../src/main/infrastructure/import/catalog-sheet'
import { ZipTooLargeError, assertZipWithinLimits } from '../../../src/main/infrastructure/import/zip-guard'
import { HEADER, SAMPLE, xlsxWithDimension } from '../../helpers/sheets'
import { declareSizes, declaredSizes, zip64Extra, zipOf } from '../../helpers/zip'

// SheetJS reads a workbook with its own inflate, which allocates the size the local header declares
// before it looks at the data: a few KB of zip that declares 4 GB cost gigabytes of memory. These
// tests count the calls of the reader to show that such an archive is refused before it is reached.
vi.mock('xlsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('xlsx')>()
  return { ...original, read: vi.fn(original.read) }
})
const sheetJsRead = vi.mocked(XLSX.read)

const MB = 1024 * 1024
const SHEET_ENTRY = 4 // xl/worksheets/sheet1.xml in `xlsxWithDimension`
const fileError = (messageKey: string) => ({ rows: [], errors: [{ row: 0, field: 'file', messageKey }] })

const WORKBOOK = xlsxWithDimension([HEADER, ...SAMPLE], 'A1:J4')
const WITH_DESCRIPTORS = xlsxWithDimension([HEADER, ...SAMPLE], 'A1:J4', { dataDescriptor: true })
const ACTUAL = declaredSizes(WORKBOOK, SHEET_ENTRY).central

describe('zip guard: declared sizes are checked against the data', () => {
  beforeEach(() => {
    sheetJsRead.mockClear()
  })

  const refused = (zip: Buffer, messageKey: string): void => {
    expect(parseCatalogSheet(zip, 'declared.xlsx')).toEqual(fileError(messageKey))
    expect(sheetJsRead).not.toHaveBeenCalled()
  }

  it('lets an honest workbook through to the reader', () => {
    expect(parseCatalogSheet(WORKBOOK, 'ok.xlsx').rows).toHaveLength(3)
    expect(sheetJsRead).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['in the local header only (what SheetJS allocates by)', { local: 450 * MB }],
    ['in the central directory only', { central: 450 * MB }],
    ['in both', { local: 450 * MB, central: 450 * MB }],
    ['of 4 GB in both', { local: 0xffffffff, central: 0xffffffff }],
    ['one byte over the limit, in the local header', { local: 50 * MB + 1 }]
  ])('refuses a declared size %s as too large, the reader never reached', (_where, sizes) => {
    refused(declareSizes(WORKBOOK, SHEET_ENTRY, sizes), 'errors.import_too_large')
  })

  it.each([
    ['in the local header, one byte more', { local: ACTUAL + 1 }],
    ['in the local header, 0 without a data descriptor', { local: 0 }],
    ['in the central directory, one byte less', { central: ACTUAL - 1 }],
    ['in the central directory, 0', { central: 0 }],
    ['in both', { local: ACTUAL + 5, central: ACTUAL + 5 }],
    ['at the limit exactly, while the data is small', { local: 50 * MB, central: 50 * MB }]
  ])('refuses a declared size that differs from the real one %s, the reader never reached', (_where, sizes) => {
    refused(declareSizes(WORKBOOK, SHEET_ENTRY, sizes), 'errors.import_unreadable')
  })

  it('tells the two refusals apart in the guard itself', () => {
    expect(() => assertZipWithinLimits(declareSizes(WORKBOOK, SHEET_ENTRY, { local: 450 * MB }))).toThrow(ZipTooLargeError)
    const mismatch = declareSizes(WORKBOOK, SHEET_ENTRY, { local: ACTUAL + 1 })
    expect(() => assertZipWithinLimits(mismatch)).toThrow(/differs/)
    expect(() => assertZipWithinLimits(mismatch)).not.toThrow(ZipTooLargeError)
    expect(() => assertZipWithinLimits(WORKBOOK)).not.toThrow()
  })

  it('counts a stored (not deflated) file by its real size, and checks its declared size', () => {
    const stored = zipOf([{ name: 'a.xml', data: Buffer.alloc(1000, 'a'), method: 0 }])
    expect(() => assertZipWithinLimits(stored)).not.toThrow()
    expect(() => assertZipWithinLimits(declareSizes(stored, 0, { central: 1001 }))).toThrow(/differs/)
    expect(() => assertZipWithinLimits(declareSizes(stored, 0, { local: 999 }))).toThrow(/differs/)
  })

  describe('a workbook written with data descriptors, as Excel writes it (local sizes are 0)', () => {
    it('is read: the central directory is the declaration', () => {
      expect(declaredSizes(WITH_DESCRIPTORS, SHEET_ENTRY).local).toBe(0)
      expect(parseCatalogSheet(WITH_DESCRIPTORS, 'excel.xlsx').rows).toHaveLength(3)
      expect(sheetJsRead).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['a central size over the limit', { central: 450 * MB }, 'errors.import_too_large'],
      ['a central size that differs', { central: ACTUAL + 1 }, 'errors.import_unreadable'],
      ['a central size of 0', { central: 0 }, 'errors.import_unreadable'],
      ['a local size that is not 0 and differs', { local: ACTUAL + 1 }, 'errors.import_unreadable'],
      ['a local size over the limit', { local: 450 * MB }, 'errors.import_too_large']
    ])('refuses %s', (_why, sizes, messageKey) => {
      refused(declareSizes(WITH_DESCRIPTORS, SHEET_ENTRY, sizes), messageKey)
    })
  })

  describe('zip64', () => {
    const sheet = Buffer.alloc(1000, 'a')
    it.each([
      ['local header', { localExtra: zip64Extra(1000, 1000) }],
      ['central directory entry', { centralExtra: zip64Extra(1000, 1000) }],
      ['local header, declaring a huge size', { localExtra: zip64Extra(4 * 1024 * MB, 100) }],
      ['central directory entry, declaring a huge size', { centralExtra: zip64Extra(4 * 1024 * MB, 100) }]
    ])('refuses a zip64 extra field in the %s as unreadable, the reader never reached', (_where, extra) => {
      refused(zipOf([{ name: 'xl/worksheets/sheet1.xml', data: sheet, ...extra }]), 'errors.import_unreadable')
    })

    it('refuses it even when the 32-bit sizes are 0xFFFFFFFF (the zip64 marker), as unreadable, not too large', () => {
      const zip = declareSizes(
        zipOf([{ name: 'a.xml', data: sheet, localExtra: zip64Extra(1000, 1000), centralExtra: zip64Extra(1000, 1000) }]),
        0,
        { local: 0xffffffff, central: 0xffffffff }
      )
      refused(zip, 'errors.import_unreadable')
    })

    it('refuses a zip64 field that follows another extra field', () => {
      const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0])
      refused(
        zipOf([{ name: 'a.xml', data: sheet, localExtra: Buffer.concat([timestamp, zip64Extra(1000, 1000)]) }]),
        'errors.import_unreadable'
      )
    })
  })
})
