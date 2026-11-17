import { describe, expect, it } from 'vitest'
import { defaultDraft, WizardPatchSchema } from '../../../src/shared/setup/draft'
import { fieldKind, issueOf, localIssues, nextPatch, stepOfField, STEP_FIELDS } from '../../../src/renderer/features/setup/steps-config'

describe('the patch "Suivant" sends', () => {
  it('carries the fields of the step and the next step number, nothing else', () => {
    const draft = { ...defaultDraft(), importFile: '/data/x.csv', logoPath: '/data/logo.png', legalFromProfile: true }
    for (const step of [1, 2, 3, 4, 5, 6]) {
      const patch = nextPatch(draft, step)
      expect(Object.keys(patch).sort()).toEqual([...(STEP_FIELDS[step] ?? []), 'step'].sort())
      expect(patch.step).toBe(step + 1)
      // the main process refuses a patch that carries what it owns
      expect(patch).not.toHaveProperty('importFile')
      expect(patch).not.toHaveProperty('logoPath')
      expect(patch).not.toHaveProperty('legalFromProfile')
      expect(WizardPatchSchema.safeParse(patch).success).toBe(true)
    }
  })

  it('sends the legal identity only from the Entreprise step', () => {
    const draft = defaultDraft()
    const withLegal = [1, 2, 3, 4, 5, 6].filter((step) => 'legal' in nextPatch(draft, step))
    expect(withLegal).toEqual([3])
  })
})

describe('field errors', () => {
  it('names the kind of a field whatever its row, and the step that shows it', () => {
    expect(fieldKind('users.1.pin')).toBe('users.pin')
    expect(fieldKind('legal.ice')).toBe('legal.ice')
    expect(stepOfField('printers.0.address')).toBe(4)
    expect(stepOfField('routing.plats')).toBe(4)
    expect(stepOfField('users.0.password')).toBe(5)
    expect(stepOfField('backups.0.path')).toBe(6)
    expect(stepOfField('importFile')).toBe(2)
    expect(stepOfField('whatever')).toBeNull()
  })

  it('reads the field out of a refusal', () => {
    expect(issueOf({ code: 'invalid_input', params: { field: 'legal.ice', reason: 'x' } })).toEqual({ field: 'legal.ice', reason: 'x' })
    expect(issueOf({ code: 'legal_not_confirmed' })).toEqual({ field: 'legal', reason: 'not_confirmed' })
    expect(issueOf({ code: 'setup_failed', params: { stage: 'seed' } })).toBeNull()
  })
})

describe('the local checks', () => {
  it('require only the trade name of the company, and refuse a malformed ICE', () => {
    expect(localIssues(3, defaultDraft()).map((issue) => issue.field)).toEqual(['legal.nomCommercial'])
    const nameOnly = { ...defaultDraft(), legal: { ...defaultDraft().legal, nomCommercial: 'Café Atlas' } }
    expect(localIssues(3, nameOnly)).toEqual([])
    expect(localIssues(3, { ...nameOnly, legal: { ...nameOnly.legal, ice: '12345' } }).map((issue) => issue.field)).toEqual(['legal.ice'])
    const filled = { ...defaultDraft(), legal: { raisonSociale: 'a', nomCommercial: 'a', adresse: 'a', ville: 'a', telephone: '1', ice: '001234567000089', if: '1', rc: '1', patente: '1' } }
    expect(localIssues(3, filled)).toEqual([])
  })

  it('check the manager, the PINs and the technician code', () => {
    const base = defaultDraft()
    const ok = { ...base, technicianCode: '246810', users: [{ displayName: 'Karim', pin: '1234', profileCode: 'gerant', username: 'karim', password: 'motdepasse-1' }] }
    expect(localIssues(5, ok)).toEqual([])
    const bad = {
      ...base,
      technicianCode: '1234',
      users: [
        { displayName: '', pin: '12', profileCode: 'gerant', username: '', password: 'short' },
        { displayName: 'Salma', pin: '1234', profileCode: 'caissier' },
        { displayName: 'Omar', pin: '1234', profileCode: 'caissier' }
      ]
    }
    const fields = localIssues(5, bad).map((issue) => issue.field)
    expect(fields).toEqual(expect.arrayContaining(['users.0.displayName', 'users.0.pin', 'users.0.username', 'users.0.password', 'users.2.pin', 'technicianCode']))
  })

  it('refuse a technician code equal to a PIN', () => {
    const draft = { ...defaultDraft(), technicianCode: '123456', users: [{ displayName: 'K', pin: '123456', profileCode: 'gerant', username: 'k', password: 'motdepasse-1' }] }
    expect(localIssues(5, draft)).toEqual([{ field: 'technicianCode', reason: 'must differ from every PIN' }])
  })
})
