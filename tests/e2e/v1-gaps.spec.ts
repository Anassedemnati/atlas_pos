import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { addProduct, login, logout, openCategory, PINS, shot, startTill, waitForPrint, type Till } from './helpers'

type Bridge = { atlas: { invoke(channel: string, input: unknown): Promise<{ ok: boolean; value?: any }> } }

/** The files of a printer folder with this extension. */
const filesOf = (dir: string, ext: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(`.${ext}`)) : [])

test.describe.serial('restaurant till: invoice, manager approvals, equal split, floor editor', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('restaurant')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('an invoice is made from a closed ticket for a new company, saved as a PDF and printed', async () => {
    const { page } = till
    await login(page, 'Karim')
    await page.getByTestId('table-4').click()
    await page.getByTestId('covers-2').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Thé à la menthe', 2)
    await page.getByTestId('pay').click()
    await page.getByTestId('method-cash').click()
    await page.getByTestId('quick-exact').click()
    await page.getByTestId('pay-validate').click()
    await waitForPrint(till.printsDir, 'caisse', '000001')

    await page.getByTestId('open-tickets').click()
    await expect(page.getByTestId('ticket-000001')).toBeVisible()
    await page.getByTestId('invoice-000001').click()
    await expect(page.getByTestId('customer-picker')).toBeVisible()
    await page.getByTestId('customer-new').click()
    await page.getByTestId('customer-name').fill('Alaoui SARL')
    await page.getByTestId('customer-ice').fill('00223344')
    // An ICE has 15 digits: the customer cannot be created before.
    await expect(page.getByTestId('customer-create')).toBeDisabled()
    await page.getByTestId('customer-ice').fill('002233445000011')
    await page.getByTestId('customer-address').fill('5 rue Atlas, Casablanca')
    await page.getByTestId('customer-create').click()
    await expect(page.getByTestId('invoice-dialog')).toBeVisible()
    await expect(page.getByTestId('invoice-number')).toHaveText(/^F-\d{4}-00001$/)
    await shot(page, '20-invoice')

    // The save dialog cannot be driven: the main process answers with this path.
    const pdfPath = join(till.dataDir, 'facture-test.pdf')
    await till.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
    }, pdfPath)
    await page.getByTestId('invoice-pdf').click()
    await expect.poll(() => existsSync(pdfPath), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF')

    // Printed on a printer that takes documents (the virtual one writes the page).
    await page.getByTestId('invoice-print-Caisse').click()
    await expect
      .poll(() => filesOf(till.printsDir, 'html').map((file) => readFileSync(join(till.printsDir, file), 'utf8')).find((html) => html.includes('Alaoui SARL')), { timeout: 20_000 })
      .toContain('002233445000011')

    // The ticket shows its invoice, and asking again opens that invoice instead of making another.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('invoice-dialog')).toHaveCount(0)
    await expect(page.getByTestId('ticket-000001')).toContainText(/F-\d{4}-00001/)
    await page.getByTestId('invoice-000001').click()
    await expect(page.getByTestId('invoice-dialog')).toBeVisible()
    await expect(page.getByTestId('invoice-number')).toHaveText(/^F-\d{4}-00001$/)
    await page.keyboard.press('Escape')
  })

  test('a cashier voids a line already in the kitchen with a manager PIN, and cannot edit the floor plan', async () => {
    const { page } = till
    await logout(page)
    await login(page, 'Sara')
    await expect(page.getByTestId('floor-canvas')).toBeVisible()
    await expect(page.getByTestId('floor-edit')).toHaveCount(0)
    await page.getByTestId('table-5').click()
    await page.getByTestId('covers-2').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Café noir')
    await page.getByTestId('send-kitchen').click()
    await waitForPrint(till.printsDir, 'bar', 'Caf')
    await page.getByTestId('line-1').click()
    await page.getByTestId('line-void').click()
    await page.getByRole('button', { name: 'Erreur de saisie' }).click()
    await expect(page.getByTestId('override-dialog')).toBeVisible()
    await page.keyboard.type(PINS.Karim)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('override-dialog')).toHaveCount(0)
    await expect(page.getByTestId('ticket-total')).toHaveText('0,00 DH')
    await waitForPrint(till.printsDir, 'bar', /ANNUL/)
    await shot(page, '21-void-sent-approved')
  })

  test('a table bill is divided in 3 equal parts, paid one after the other, on one ticket', async () => {
    const { page } = till
    await page.getByTestId('back-home').click()
    await page.getByTestId('table-6').click()
    await page.getByTestId('covers-3').click()
    await openCategory(page, 'Plats')
    await addProduct(page, 'Tajine de poulet au citron confit', 2)
    await page.getByTestId('modifiers-confirm').click()
    await addProduct(page, 'Couscous royal')
    await page.getByRole('button', { name: 'Sans oignon' }).click()
    await page.getByTestId('modifiers-confirm').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Thé à la menthe', 3)
    await expect(page.getByTestId('ticket-total')).toHaveText('271,00 DH')

    await page.getByTestId('split').click()
    await page.getByRole('tab', { name: 'Parts égales' }).click()
    await page.getByTestId('equal-3').click()
    await expect(page.getByTestId('equal-part')).toHaveText('Part 1/3 : 90,34 DH')
    await shot(page, '22-equal-split')
    await page.getByTestId('equal-method-cash').click()
    await expect(page.getByTestId('equal-part')).toHaveText('Part 2/3 : 90,33 DH')
    await page.getByTestId('equal-method-cash').click()
    await expect(page.getByTestId('equal-part')).toHaveText('Part 3/3 : 90,33 DH')
    await page.getByTestId('equal-method-cash').click()
    await expect(page.getByTestId('floor-canvas')).toBeVisible()
    const receipt = await waitForPrint(till.printsDir, 'caisse', '000002')
    expect(receipt).toContain('271,00')
    await expect(page.getByTestId('table-6')).toHaveAttribute('data-state', 'free')
  })

  test('covers and customer can be changed after the order was opened', async () => {
    const { page } = till
    await logout(page)
    await login(page, 'Karim')
    await page.getByTestId('table-7').click()
    await page.getByTestId('covers-2').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Café noir')
    await expect(page.getByTestId('ticket-panel')).toContainText('2 couverts')
    await page.getByTestId('ticket-more').click()
    await page.getByTestId('ticket-covers').click()
    await page.getByTestId('covers-4').click()
    await expect(page.getByTestId('ticket-panel')).toContainText('4 couverts')

    await page.getByTestId('ticket-more').click()
    await page.getByTestId('ticket-customer').click()
    await page.getByTestId('customer-search').fill('Alaoui')
    await page.getByTestId('customer-results').getByRole('button', { name: /Alaoui SARL/ }).click()
    await expect(page.getByTestId('ticket-customer-name')).toContainText('Alaoui SARL')
    await page.getByTestId('ticket-more').click()
    await page.getByTestId('ticket-customer').click()
    await page.getByTestId('customer-clear').click()
    await expect(page.getByTestId('ticket-customer-name')).toHaveCount(0)
    await page.getByTestId('back-home').click()
  })

  test('the floor plan editor moves, resizes, adds and removes tables, and refuses to remove a table with an order', async () => {
    const { page } = till
    const floor = async () =>
      page.evaluate(async () => {
        const result = await (window as unknown as Bridge).atlas.invoke('floor.list', {})
        return result.value as { tables: { id: string; label: string; x: number; y: number; w: number; h: number; active: boolean }[] }
      })
    const before = await floor()
    const t6 = before.tables.find((table) => table.label === '6')!

    await page.getByTestId('floor-edit').click()
    await expect(page.getByTestId('floor-editor')).toBeVisible()
    await expect(page.getByTestId('editor-save')).toBeDisabled()

    // Drag table 6 to the right and down.
    await page.getByTestId('edit-table-6').click()
    await expect(page.getByTestId('edit-table-6')).toHaveAttribute('data-selected', 'true')
    let box = (await page.getByTestId('edit-table-6').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 })
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 5 })
    await page.mouse.up()
    const moved = (await page.getByTestId('edit-table-6').boundingBox())!
    expect(moved.x).toBeGreaterThan(box.x + 100)
    expect(moved.y).toBeGreaterThan(box.y + 50)

    // Pull its bottom corner.
    box = moved
    const handle = (await page.getByTestId('handle-se').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + handle.height / 2 + 50, { steps: 5 })
    await page.mouse.up()
    const grown = (await page.getByTestId('edit-table-6').boundingBox())!
    expect(grown.width).toBeGreaterThan(box.width + 40)
    expect(grown.height).toBeGreaterThan(box.height + 20)

    // A new table, with a name and a shape; one that exists is removed; a table with an open order cannot be.
    await page.getByTestId('editor-add-table').click()
    await expect(page.getByTestId('edit-table-15')).toBeVisible()
    await page.getByTestId('editor-seats-plus').click()
    await expect(page.getByTestId('editor-seats')).toHaveText('5')
    await page.getByRole('tab', { name: 'Ronde' }).click()
    await expect(page.getByTestId('edit-table-15')).toHaveClass(/table-tile--round/)
    await page.getByTestId('edit-table-14').click()
    await page.getByTestId('editor-delete-table').click()
    await expect(page.getByTestId('edit-table-14')).toHaveCount(0)
    await page.getByTestId('edit-table-5').click()
    await expect(page.getByTestId('editor-delete-table')).toBeDisabled()
    await shot(page, '23-floor-editor')

    await page.getByTestId('editor-save').click()
    await expect(page.getByTestId('floor-editor')).toHaveCount(0)
    await expect(page.getByTestId('table-15')).toBeVisible()
    await expect(page.getByTestId('table-14')).toHaveCount(0)

    const after = await floor()
    expect(after.tables.find((table) => table.id === t6.id)!.x).toBeGreaterThan(t6.x + 50)
    expect(after.tables.find((table) => table.id === t6.id)!.w).toBeGreaterThan(t6.w)
    expect(after.tables.find((table) => table.label === '15')).toMatchObject({ active: true })
    expect(after.tables.find((table) => table.label === '14')).toBeUndefined()
  })
})
