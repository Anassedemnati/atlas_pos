// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../src/renderer/app/i18n'
import { Keypad, applyKey } from '../../../src/renderer/ui'

afterEach(cleanup)

const tap = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }))

describe('Keypad', () => {
  it('masks the digits of a PIN and hands the whole PIN to onEnter', () => {
    const onEnter = vi.fn()
    render(<Keypad mode="pin" onEnter={onEnter} />)
    for (const digit of ['1', '2', '3', '4']) tap(digit)

    const display = screen.getByTestId('keypad-display')
    expect(display.textContent).toBe('••••')
    expect(display.textContent).not.toMatch(/\d/)

    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect(onEnter).toHaveBeenCalledExactlyOnceWith('1234')
  })

  it('keeps Enter disabled until the PIN has 4 digits and stops at 6', () => {
    render(<Keypad mode="pin" />)
    const enter = screen.getByRole('button', { name: 'Valider' }) as HTMLButtonElement
    for (const digit of ['1', '2', '3']) tap(digit)
    expect(enter.disabled).toBe(true)
    for (const digit of ['4', '5', '6', '7', '8']) tap(digit)
    expect(enter.disabled).toBe(false)
    expect(screen.getByTestId('keypad-display').textContent).toBe('••••••')
  })

  it('reports each key, Backspace separately, and works controlled', () => {
    const onDigit = vi.fn()
    const onBackspace = vi.fn()
    const onChange = vi.fn()
    render(<Keypad mode="qty" value="" onDigit={onDigit} onBackspace={onBackspace} onChange={onChange} />)
    tap('7')
    tap('Effacer le dernier chiffre')
    expect(onDigit).toHaveBeenCalledExactlyOnceWith('7')
    expect(onBackspace).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenNthCalledWith(1, '7')
    expect(onChange).toHaveBeenNthCalledWith(2, '')
  })
})

describe('applyKey', () => {
  it('types amounts with at most two decimals', () => {
    let value = ''
    for (const key of ['1', '2', ',', '5', '0', '9']) value = applyKey(value, key, 'money')
    expect(value).toBe('12,50')
    expect(applyKey('12,50', ',', 'money')).toBe('12,50')
  })

  it('types quantities with up to three decimals and replaces a lone zero', () => {
    expect(['0', ',', '3', '5', '0', '1'].reduce((v, k) => applyKey(v, k, 'qty'), '')).toBe('0,350')
    expect(applyKey('0', '5', 'qty')).toBe('5')
    expect(applyKey('', ',', 'qty')).toBe('0,')
    expect(applyKey('5', '00', 'money')).toBe('500')
  })

  it('knows no comma in a PIN and no key beyond its length', () => {
    expect(applyKey('12', ',', 'pin')).toBe('12')
    expect(applyKey('0', '0', 'pin')).toBe('00')
    expect(applyKey('123456', '7', 'pin')).toBe('123456')
    expect(applyKey('12', 'Backspace', 'pin')).toBe('1')
  })
})
