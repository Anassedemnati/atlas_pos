// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../src/renderer/app/i18n'
import { Button, Stepper, TOUCH, Toggle } from '../../../src/renderer/ui'

afterEach(cleanup)

describe('Toggle', () => {
  it('is a switch that reports the value it would take', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Toggle label="Stock" checked={false} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Stock' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true)

    rerender(<Toggle label="Stock" checked onChange={onChange} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })
})

describe('Button', () => {
  it('sets a finger-sized floor: md 64, lg 72, xl 88 (class, rule and token)', () => {
    render(
      <>
        <Button size="md">md</Button>
        <Button size="lg">lg</Button>
        <Button size="xl">xl</Button>
      </>
    )
    const tokens = readFileSync(resolve('src/renderer/theme/tokens.css'), 'utf8')
    const rules = readFileSync(resolve('src/renderer/ui/ui.css'), 'utf8')
    // The height of a size: its button class -> the rule's `min-block-size: var(--token)` -> the token's px.
    const height = (size: string): number => {
      expect(screen.getByRole('button', { name: size }).className).toContain(`btn--${size}`)
      const token = new RegExp(`\\.btn--${size}\\s*\\{[^}]*min-block-size:\\s*var\\((--[\\w-]+)\\)`).exec(rules)?.[1]
      expect(token, `.btn--${size} must set min-block-size from a token`).toBeDefined()
      return Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(tokens)?.[1])
    }
    expect(height('md')).toBeGreaterThanOrEqual(64)
    expect(height('lg')).toBeGreaterThanOrEqual(72)
    expect(height('xl')).toBeGreaterThanOrEqual(88)
  })

  it('keeps the stylesheet tokens and the TypeScript metrics in step', () => {
    const tokens = readFileSync(resolve('src/renderer/theme/tokens.css'), 'utf8')
    for (const [size, px] of Object.entries(TOUCH)) expect(tokens).toContain(`--touch-${size}: ${px}px;`)
    expect(tokens).toMatch(/--radius: 14px;/)
  })

  it('is a type=button by default and passes the variant as a class', () => {
    render(<Button variant="danger">Supprimer</Button>)
    const button = screen.getByRole('button', { name: 'Supprimer' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).toContain('btn--danger')
  })
})

describe('Stepper', () => {
  it('marks the current step and the finished ones', () => {
    render(<Stepper steps={['Langue', 'Type', 'Entreprise']} current={1} />)
    const items = screen.getAllByRole('listitem')
    expect(items[1]!.getAttribute('aria-current')).toBe('step')
    expect(items[0]!.className).toContain('stepper__step--done')
    expect(items[2]!.className).toContain('stepper__step--todo')
  })
})
