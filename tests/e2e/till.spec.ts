import { expect, test } from '@playwright/test'
import { addProduct, login, logout, openCategory, PINS, printed, shot, startTill, waitForPrint, type Till } from './helpers'

test.describe.serial('restaurant till', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('restaurant')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('login: tiles, wrong PIN five times locks the user for a minute', async () => {
    const { page } = till
    await shot(page, '01-login')
    await page.getByTestId('user-Youssef').click()
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.keyboard.type('9999')
      await expect(page.locator('.keypad__dot--filled')).toHaveCount(4)
      await page.keyboard.press('Enter')
      // The keypad is emptied once the main process has answered.
      await expect(page.locator('.keypad__dot--filled')).toHaveCount(0)
    }
    await expect(page.getByTestId('login-message')).toContainText(/dans \d+ s/)
    await shot(page, '02-login-locked')
  })

  test('table 4: items, kitchen, mixed payment, receipt', async () => {
    const { page } = till
    await login(page, 'Karim')
    await expect(page.getByTestId('floor-canvas')).toBeVisible()
    await shot(page, '03-floor')

    await page.getByTestId('table-4').click()
    await page.getByTestId('covers-3').click()
    await expect(page.getByTestId('order-pad')).toBeVisible()
    await expect(page.getByTestId('ticket-title')).toContainText('4')

    await openCategory(page, 'Plats')
    await addProduct(page, 'Tajine de poulet au citron confit', 2)
    await page.getByTestId('modifiers-confirm').click()
    await addProduct(page, 'Couscous royal')
    await page.getByRole('button', { name: 'Sans oignon' }).click()
    await page.getByTestId('modifiers-confirm').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Thé à la menthe', 3)

    await expect(page.getByTestId('ticket-total')).toHaveText('271,00 DH')
    await expect(page.getByTestId('ticket-lines')).toContainText('Sans oignon')
    await shot(page, '04-order-pad')

    await page.getByTestId('send-kitchen').click()
    const kitchen = await waitForPrint(till.printsDir, 'cuisine', 'Tajine')
    expect(kitchen).toContain('Couscous')
    await waitForPrint(till.printsDir, 'bar', 'Th')

    await page.getByTestId('pay').click()
    await expect(page.getByTestId('pay-screen')).toBeVisible()
    await page.getByTestId('method-card').click()
    await page.keyboard.type('100')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('pay-due')).toHaveText('171,00 DH')
    await page.getByTestId('method-cash').click()
    await page.getByTestId('quick-200').click()
    await expect(page.getByTestId('pay-change')).toContainText('29,00 DH')
    await shot(page, '05-payment')
    await page.getByTestId('pay-validate').click()
    await expect(page.getByTestId('floor-canvas')).toBeVisible()

    const receipt = await waitForPrint(till.printsDir, 'caisse', '000001')
    expect(receipt).toContain('271,00')
    await expect(page.getByTestId('table-4')).toHaveAttribute('data-state', 'free')
  })

  test('a cashier over the discount limit needs a manager PIN', async () => {
    const { page } = till
    await logout(page)
    await login(page, 'Sara')
    await page.getByTestId('table-5').click()
    await page.getByTestId('covers-2').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Café noir')
    await page.getByTestId('discount').click()
    await page.getByTestId('discount-15').click()
    await page.getByRole('button', { name: 'Appliquer' }).click()
    await page.getByRole('button', { name: 'Geste commercial' }).click()
    await expect(page.getByTestId('override-dialog')).toBeVisible()
    await page.keyboard.type(PINS.Karim)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('override-dialog')).toHaveCount(0)
    await expect(page.getByTestId('ticket-lines')).toBeVisible()
    await expect(page.getByTestId('ticket-total')).toHaveText('8,50 DH')
    // Leave the order open for the closure test.
  })

  test('the pre-bill prints ADDITION and turns the table amber', async () => {
    const { page } = till
    await page.getByTestId('prebill').click()
    await waitForPrint(till.printsDir, 'caisse', 'ADDITION')
    await page.getByTestId('back-home').click()
    await expect(page.getByTestId('table-5')).toHaveAttribute('data-state', 'bill')
  })

  test('the Z closure is blocked by an open order; the cancelled ticket prints a credit note', async () => {
    const { page } = till
    await logout(page)
    await login(page, 'Karim')
    await page.getByTestId('open-closure').click()
    await expect(page.getByTestId('z-view')).toBeVisible()
    await page.getByTestId('close-day').click()
    await page.getByRole('button', { name: 'Clôturer la journée (Z)' }).last().click()
    await expect(page.getByTestId('closure-blocked')).toBeVisible()
    await shot(page, '06-closure-blocked')

    // The cancellation of ticket 000001
    await page.getByTestId('back-home').click()
    await page.getByTestId('open-tickets').click()
    await expect(page.getByTestId('ticket-000001')).toBeVisible()
    await page.getByTestId('cancel-000001').click()
    await page.getByRole('button', { name: 'Erreur de saisie' }).click()
    await waitForPrint(till.printsDir, 'caisse', 'AV-000001')
    await expect(page.getByTestId('ticket-AV-000001')).toBeVisible()
  })

  test('transfer table 2 to table 7, then pay the open orders and close the day', async () => {
    const { page } = till
    await page.getByTestId('back-home').click()
    await page.getByTestId('table-2').click()
    await page.getByTestId('covers-2').click()
    await openCategory(page, 'Boissons chaudes')
    await addProduct(page, 'Café noir')
    await page.getByTestId('back-home').click()
    await expect(page.getByTestId('table-2')).toHaveAttribute('data-state', 'busy')
    // Long press
    const box = (await page.getByTestId('table-2').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(900)
    await page.mouse.up()
    await page.getByTestId('table-transfer').click()
    await page.getByTestId('transfer-to-7').click()
    await expect(page.getByTestId('table-7')).toHaveAttribute('data-state', 'busy')
    await expect(page.getByTestId('table-2')).toHaveAttribute('data-state', 'free')

    // Pay the two open orders (tables 5 and 7) in cash, exact.
    for (const table of ['5', '7']) {
      await page.getByTestId(`table-${table}`).click()
      await page.getByTestId('pay').click()
      await page.getByTestId('method-cash').click()
      await page.getByTestId('quick-exact').click()
      await page.getByTestId('pay-validate').click()
      await expect(page.getByTestId('floor-canvas')).toBeVisible()
    }
    await page.getByTestId('open-closure').click()
    await page.getByTestId('close-day').click()
    await page.getByRole('button', { name: 'Clôturer la journée (Z)' }).last().click()
    await expect(page.getByTestId('z-done')).toContainText('Z n° 1')
    await shot(page, '07-closure-done')
    await waitForPrint(till.printsDir, 'caisse', 'RAPPORT Z')
    await expect(page.getByTestId('z-history')).toContainText('Z1')
  })

  test('Arabic: the ticket moves to the right and the keys speak Arabic', async () => {
    const { page } = till
    await page.getByTestId('back-home').click()
    await page.getByTestId('direct-sale').click()
    await page.locator('.topbar__user').click()
    await page.getByTestId('lang-ar').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    const ticket = (await page.getByTestId('ticket-panel').boundingBox())!
    const catalog = (await page.getByTestId('catalog').boundingBox())!
    expect(ticket.x).toBeGreaterThan(catalog.x)
    await expect(page.getByTestId('product-grid').getByRole('button').first()).toHaveAccessibleName(/[؀-ۿ]/)
    await shot(page, '08-order-arabic')
    // Back to French for whatever follows.
    await page.locator('.topbar__user').click()
    await page.getByTestId('lang-fr').click()
    await page.keyboard.press('Escape')
  })

  test('the technician menu: wrong code refused, right code opens it', async () => {
    const { page } = till
    await page.locator('.topbar__brand').dispatchEvent('pointerdown')
    await page.waitForTimeout(3300)
    await expect(page.getByTestId('tech-code')).toBeVisible()
    await page.keyboard.type('000000')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Code technicien incorrect')).toBeVisible()
    await page.keyboard.type('654321')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('tech-menu')).toBeVisible()
    await page.getByRole('tab', { name: 'Journal' }).click()
    await expect(page.getByTestId('tech-logs')).toBeVisible()
    await shot(page, '09-tech-menu')
    expect(printed(till.printsDir, 'caisse').length).toBeGreaterThan(2)
  })
})

test.describe('café: served at the table or the counter, paid when leaving', () => {
  let till: Till
  test.beforeAll(async () => {
    till = await startTill('cafe')
  })
  test.afterAll(async () => {
    await till?.close().catch(() => undefined)
    till?.cleanup()
  })

  test('the waiter serves table 1, prints its addition, and the customer pays when leaving', async () => {
    const { page } = till
    await login(page, 'Youssef')
    await expect(page.getByTestId('floor-canvas')).toBeVisible()
    await page.getByTestId('table-1').click()
    await page.getByTestId('covers-2').click()
    await openCategory(page, 'Jus et boissons fraîches')
    await addProduct(page, 'Zaazaa')
    await page.getByTestId('send-kitchen').click()
    await waitForPrint(till.printsDir, 'bar', 'Zaazaa')
    await page.getByTestId('prebill').click()
    await waitForPrint(till.printsDir, 'caisse', 'ADDITION')
    await page.getByTestId('back-home').click()
    await expect(page.getByTestId('table-1')).toHaveAttribute('data-state', 'bill')
    await page.getByTestId('table-1').click()
    await page.getByTestId('pay').click()
    await page.getByTestId('method-cash').click()
    await page.getByTestId('quick-exact').click()
    await page.getByTestId('pay-validate').click()
    await expect(page.getByTestId('table-1')).toHaveAttribute('data-state', 'free')
    await logout(page)
  })

  test('a counter order prints its addition, waits in the parked list, and is paid later', async () => {
    const { page } = till
    await login(page, 'Youssef')
    await page.getByTestId('direct-sale').click()
    await openCategory(page, 'Jus et boissons fraîches')
    await addProduct(page, 'Lben')
    await page.getByTestId('prebill').click()
    await waitForPrint(till.printsDir, 'caisse', 'ADDITION')
    await expect(page.getByTestId('floor-canvas')).toBeVisible()
    await page.getByTestId('direct-sale').click()
    await page.getByTestId('open-parked').click()
    await page.getByTestId('parked-orders').getByRole('button').first().click()
    await page.getByTestId('pay').click()
    await page.getByTestId('method-cash').click()
    await page.getByTestId('quick-exact').click()
    await page.getByTestId('pay-validate').click()
    await expect(page.getByTestId('floor-canvas')).toBeVisible()
    await logout(page)
  })

  test('two takeaway orders get the numbers 2 and 3 on their tickets', async () => {
    const { page } = till
    await login(page, 'Karim')
    // The counter order above took number 1.
    for (const expected of [2, 3]) {
      await page.getByTestId('direct-sale').click()
      await expect(page.getByTestId('order-pad')).toBeVisible()
      await page.getByRole('tab', { name: 'À emporter', exact: true }).click()
      await openCategory(page, 'Viennoiseries')
      await page.getByTestId('product-grid').getByRole('button').first().click()
      await expect(page.getByTestId('ticket-title')).toContainText(String(expected))
      await page.getByTestId('send-kitchen').click()
      await waitForPrint(till.printsDir, 'cuisine', new RegExp(`N° ${expected}\\b`))
      await page.getByTestId('pay').click()
      await page.getByTestId('method-cash').click()
      await page.getByTestId('quick-exact').click()
      await page.getByTestId('pay-validate').click()
      await expect(page.getByTestId('floor-canvas')).toBeVisible()
    }
    await waitForPrint(till.printsDir, 'caisse', '000004')
  })
})
