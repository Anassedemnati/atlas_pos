import { describe, expect, it } from 'vitest'
import { opensDatabase, routeFor } from '../../../src/main/lifecycle/routing'

describe('start-up route', () => {
  it('sends each start-up state to its screen', () => {
    const normal = { safeMode: false }
    expect(routeFor('needs-setup', normal)).toBe('#/setup')
    expect(routeFor('corrupt', normal)).toBe('#/recovery?mode=corrupt')
    expect(routeFor('newer-schema', normal)).toBe('#/recovery?mode=newer-schema')
    expect(routeFor('recovered', normal)).toBe('#/recovery')
    expect(routeFor('ok', normal)).toBe('#/login')
    expect(routeFor(null, normal)).toBe('#/recovery?mode=error')
  })

  it('shows the safe-mode screen instead of the till after repeated crashes', () => {
    const safe = { safeMode: true }
    expect(routeFor('ok', safe)).toBe('#/recovery?mode=safe')
    expect(routeFor('recovered', safe)).toBe('#/recovery?mode=safe')
    expect(routeFor('needs-setup', safe)).toBe('#/setup')
    expect(routeFor('corrupt', safe)).toBe('#/recovery?mode=corrupt')
  })

  it('opens the database for ok and recovered only', () => {
    expect(['needs-setup', 'ok', 'recovered', 'corrupt', 'newer-schema'].filter((s) => opensDatabase(s as never))).toEqual(['ok', 'recovered'])
  })
})
