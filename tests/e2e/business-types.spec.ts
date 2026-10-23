import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { addProduct, login, openCategory, shot, startTill, waitForPrint, type Till } from './helpers'

const require = createRequire(import.meta.url)

test.describe('bakery: weight sale', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('bakery')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('0,350 kg of Chebakia at 120,00 DH/kg is 42,00 DH', async () => {
    const { page } = till
    await login(page, 'Karim')
    await openCategory(page, 'Pâtisserie marocaine')
    await page.getByRole('button', { name: 'Chebakia', exact: true }).click()
    await expect(page.getByTestId('weight-dialog')).toBeVisible()
    await page.keyboard.type('0,350')
    await expect(page.getByTestId('weight-total')).toContainText('42,00 DH')
    await shot(till.page, '10-bakery-weight')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('ticket-total')).toHaveText('42,00 DH')
    await expect(page.getByTestId('ticket-lines')).toContainText('0,350 kg')
    await page.getByTestId('pay').click()
    await page.getByTestId('method-cash').click()
    await page.getByTestId('quick-exact').click()
    await page.getByTestId('pay-validate').click()
    const receipt = await waitForPrint(till.printsDir, 'caisse', '000001')
    expect(receipt).toContain('42,00')
  })
})

test.describe('bakery: photo keys', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('bakery')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('with photo keys the products show their picture from the media folder', async () => {
    const { page } = till
    await login(page, 'Karim')
    const changed = await page.evaluate(async () => {
      const bridge = (window as unknown as { atlas: { invoke(c: string, i: unknown): Promise<{ ok: boolean }> } }).atlas
      return (await bridge.invoke('settings.set', { key: 'ui.keyStyle', value: 'photo' })).ok
    })
    expect(changed).toBe(true)
    const image = page.locator('.product-key__image').first()
    await expect(image).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await shot(page, '15-bakery-photo-keys')
  })
})

test.describe('retail: barcode sale', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('retail')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('scanning adds the item, an unknown barcode opens quick create, stock goes down', async () => {
    const { page } = till
    await login(page, 'Karim')
    const scan = page.getByTestId('scan-input')
    await expect(scan).toBeFocused()
    await scan.fill('2000000000015')
    await scan.press('Enter')
    await expect(page.getByTestId('ticket-total')).toHaveText('8,00 DH')
    await expect(scan).toBeFocused()

    await scan.fill('9999999999994')
    await scan.press('Enter')
    await expect(page.getByTestId('quick-create')).toBeVisible()
    await page.getByTestId('quick-name').fill('Biscuit test')
    await page.getByTestId('quick-price').fill('12,5')
    await shot(page, '11-retail-quick-create')
    await page.getByTestId('quick-confirm').click()
    await expect(page.getByTestId('ticket-lines')).toContainText('Biscuit test')
    await expect(page.getByTestId('ticket-total')).toHaveText('20,50 DH')

    await page.getByTestId('pay').click()
    await page.getByTestId('method-cash').click()
    await page.getByTestId('quick-exact').click()
    await page.getByTestId('pay-validate').click()
    await expect(page.getByTestId('order-pad')).toBeVisible()
    await waitForPrint(till.printsDir, 'caisse', '000001')
    // 24 in stock, one sold.
    await expect(page.getByTestId('product-grid')).toContainText('Stock : 23')
    await shot(page, '12-retail-pad')
  })
})

test.describe('restaurant: power cut and previous day', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('restaurant')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('killed during an open order: the recovery screen lists the table, and the floor shows it occupied', async () => {
    await login(till.page, 'Karim')
    await till.page.getByTestId('table-9').click()
    await till.page.getByTestId('covers-4').click()
    await openCategory(till.page, 'Boissons chaudes')
    await addProduct(till.page, 'Café noir')
    await expect(till.page.getByTestId('ticket-total')).toHaveText('10,00 DH')
    await till.kill()
    await till.relaunch()
    await till.page.waitForSelector('[data-testid="recovery"]', { timeout: 30_000 })
    await expect(till.page.getByTestId('recovery')).toContainText('T9')
    await shot(till.page, '13-recovery')
    await till.page.getByTestId('recovery-continue').click()
    await login(till.page, 'Karim')
    await expect(till.page.getByTestId('table-9')).toHaveAttribute('data-state', 'busy')
  })

  test('a business day older than 24 h asks for its Z before selling', async () => {
    await till.close()
    // The open day (the order above) opened two days ago.
    const Database = require('better-sqlite3') as new (file: string) => { prepare(sql: string): { run(...args: unknown[]): void }; close(): void }
    const db = new Database(join(till.dataDir, 'db', 'atlas.db'))
    db.prepare('UPDATE business_days SET opened_at = ? WHERE closed_at IS NULL').run(new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString())
    db.close()
    await till.relaunch()
    await login(till.page, 'Karim')
    await expect(till.page.getByTestId('day-gate')).toBeVisible()
    await shot(till.page, '14-day-gate')
    // The open order blocks the Z: the gate says so and lets the order be finished.
    await till.page.getByTestId('gate-close-day').click()
    await expect(till.page.getByTestId('blocking-orders')).toBeVisible()
  })
})
