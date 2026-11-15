import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { printersForTarget, readRouting, routeKitchen, type KitchenRouting } from '../../../src/main/infrastructure/printing/router'
import { tempDb, type TempDb } from '../../helpers/db'
import { addPrinter, routeCategory } from '../../helpers/printing'

describe('routeKitchen', () => {
  const routing = (byCategory: Record<string, string[]>, fallback?: string): KitchenRouting => ({
    byCategory: new Map(Object.entries(byCategory)),
    fallback
  })
  const line = (id: string, categoryId: string | null) => ({ id, categoryId })

  it('sends Boissons to the Bar printer and Plats to the Cuisine one', () => {
    const routed = routeKitchen(
      [line('tajine', 'plats'), line('the', 'boissons'), line('couscous', 'plats'), line('eau', 'boissons')],
      routing({ plats: ['cuisine'], boissons: ['bar'] })
    )
    expect([...routed.keys()].sort()).toEqual(['bar', 'cuisine'])
    expect(routed.get('cuisine')!.map((l) => l.id)).toEqual(['tajine', 'couscous'])
    expect(routed.get('bar')!.map((l) => l.id)).toEqual(['the', 'eau'])
  })

  it('puts a line on every printer its category routes to', () => {
    const routed = routeKitchen([line('pizza', 'plats')], routing({ plats: ['cuisine', 'pass'] }))
    expect(routed.get('cuisine')!.map((l) => l.id)).toEqual(['pizza'])
    expect(routed.get('pass')!.map((l) => l.id)).toEqual(['pizza'])
  })

  it('sends a category with no route, and a line of unknown category, to the first kitchen printer', () => {
    const routed = routeKitchen([line('glace', 'desserts'), line('mystere', null), line('the', 'boissons')], routing({ boissons: ['bar'] }, 'cuisine'))
    expect(routed.get('cuisine')!.map((l) => l.id)).toEqual(['glace', 'mystere'])
    expect(routed.get('bar')!.map((l) => l.id)).toEqual(['the'])
  })

  it('leaves out lines with nowhere to print', () => {
    expect(routeKitchen([line('glace', 'desserts')], routing({})).size).toBe(0)
  })

  it('keeps the lines in the order given', () => {
    const lines = ['c', 'a', 'b'].map((id) => line(id, 'plats'))
    expect(routeKitchen(lines, routing({ plats: ['cuisine'] })).get('cuisine')!.map((l) => l.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('routing and targets from the database', () => {
  let t: TempDb
  beforeEach(() => {
    t = tempDb()
    for (const id of ['plats', 'boissons']) t.db.prepare('INSERT INTO categories (id, name_json, color) VALUES (?, ?, ?)').run(id, JSON.stringify({ fr: id }), '#000000')
  })
  afterEach(() => t.cleanup())

  it('reads category_printers of the active printers, and the first active kitchen printer as the fallback', () => {
    addPrinter(t.db, { id: 'p1', name: 'Vieille cuisine', role: 'kitchen', active: false })
    addPrinter(t.db, { id: 'p2', name: 'Cuisine', role: 'kitchen' })
    addPrinter(t.db, { id: 'p3', name: 'Bar', role: 'bar' })
    routeCategory(t.db, 'plats', 'p1')
    routeCategory(t.db, 'plats', 'p2')
    routeCategory(t.db, 'boissons', 'p3')
    const routing = readRouting(t.db)
    expect(routing.byCategory.get('plats')).toEqual(['p2'])
    expect(routing.byCategory.get('boissons')).toEqual(['p3'])
    expect(routing.fallback).toBe('p2')
  })

  it('has no fallback without an active kitchen printer (a bar printer is not one)', () => {
    addPrinter(t.db, { id: 'p3', name: 'Bar', role: 'bar' })
    expect(readRouting(t.db).fallback).toBeUndefined()
  })

  it('resolves a target to the printer it names or to the active printers of its role, by id', () => {
    addPrinter(t.db, { id: 'p2', name: 'Caisse 2', role: 'receipt' })
    addPrinter(t.db, { id: 'p1', name: 'Caisse 1', role: 'receipt' })
    addPrinter(t.db, { id: 'p9', name: 'Éteinte', role: 'receipt', active: false })
    expect(printersForTarget(t.db, { role: 'receipt' }).map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(printersForTarget(t.db, { printerId: 'p2' }).map((p) => p.id)).toEqual(['p2'])
    expect(printersForTarget(t.db, { printerId: 'p9' })).toEqual([])
    expect(printersForTarget(t.db, { printerId: 'nope' })).toEqual([])
    expect(printersForTarget(t.db, {})).toEqual([])
    expect(printersForTarget(t.db, { role: 'receipt' })[0]).toEqual({
      id: 'p1',
      name: 'Caisse 1',
      kind: 'virtual',
      address: '',
      widthMm: 80,
      lang: 'fr',
      raster: false,
      role: 'receipt',
      active: true
    })
  })
})
