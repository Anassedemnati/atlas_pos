// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../src/renderer/app/i18n'
import { TextField, TillKeyboardProvider } from '../../../src/renderer/ui'

afterEach(cleanup)

function Harness({ till, inputMode }: { till?: boolean; inputMode?: 'numeric' | 'decimal' }) {
  const [value, setValue] = useState('')
  return (
    <TillKeyboardProvider till={till}>
      <TextField label="Nom" value={value} onChange={setValue} inputMode={inputMode} />
      <output data-testid="value">{value}</output>
    </TillKeyboardProvider>
  )
}

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 5))))

describe('TextField at the till', () => {
  it('opens the on-screen keyboard on focus, types into the field and closes on blur', async () => {
    render(<Harness />)
    const input = screen.getByLabelText('Nom') as HTMLInputElement
    expect(screen.queryByTestId('kbd-dock')).toBeNull()
    // The system keyboard must stay away at the till.
    expect(input.getAttribute('inputmode')).toBe('none')

    fireEvent.focus(input)
    expect(screen.getByTestId('kbd-dock')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'z' }))
    expect(screen.getByTestId('value').textContent).toBe('az')
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }))
    expect(screen.getByTestId('value').textContent).toBe('a')

    fireEvent.blur(input)
    await settle()
    expect(screen.queryByTestId('kbd-dock')).toBeNull()
  })

  it('shows a keypad for a numeric field', () => {
    render(<Harness inputMode="numeric" />)
    fireEvent.focus(screen.getByLabelText('Nom'))
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(screen.getByTestId('value').textContent).toBe('42')
    expect(screen.queryByRole('button', { name: 'a' })).toBeNull()
  })

  it('stays out of the way when the window is not a till', () => {
    render(<Harness till={false} />)
    const input = screen.getByLabelText('Nom')
    fireEvent.focus(input)
    expect(screen.queryByTestId('kbd-dock')).toBeNull()
    expect(input.getAttribute('inputmode')).not.toBe('none')
  })

  it('calls onEnter from the keyboard Enter key', () => {
    const onEnter = vi.fn()
    render(
      <TillKeyboardProvider>
        <TextField label="Code" value="" onChange={() => {}} onEnter={onEnter} />
      </TillKeyboardProvider>
    )
    fireEvent.focus(screen.getByLabelText('Code'))
    fireEvent.click(screen.getByRole('button', { name: 'Entrée' }))
    expect(onEnter).toHaveBeenCalledOnce()
  })
})
