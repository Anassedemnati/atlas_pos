/** Key rows of the on-screen keyboard. Special keys are named in `OnScreenKeyboard`; everything else is typed as is. */
export type KeyboardLayout = 'azerty' | 'arabic' | 'qwerty'

export interface LayoutRows {
  digits: string[]
  rows: string[][]
  /** Keys beside the space bar. */
  punctuation: { before: string[]; after: string[] }
  /** Latin layouts have a Shift key; Arabic has none. */
  shift: boolean
}

const DIGITS = '1234567890'.split('')

export const LAYOUTS: Record<KeyboardLayout, LayoutRows> = {
  azerty: {
    digits: DIGITS,
    rows: ['azertyuiop'.split(''), 'qsdfghjklm'.split(''), "wxcvbn'".split('')],
    punctuation: { before: ['-', '@'], after: ['.', ','] },
    shift: true
  },
  qwerty: {
    digits: DIGITS,
    rows: ['qwertyuiop'.split(''), 'asdfghjkl'.split(''), "zxcvbnm'".split('')],
    punctuation: { before: ['-', '@'], after: ['.', ','] },
    shift: true
  },
  arabic: {
    digits: DIGITS,
    rows: [
      ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج', 'د'],
      ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك', 'ط'],
      ['ئ', 'ء', 'ؤ', 'ر', 'لا', 'ى', 'ة', 'و', 'ز', 'ظ']
    ],
    punctuation: { before: ['-', '@'], after: ['.', '،'] },
    shift: false
  }
}

/** The keyboard that suits a UI language. */
export const layoutForLanguage = (lang: string): KeyboardLayout => (lang === 'ar' ? 'arabic' : lang === 'en' ? 'qwerty' : 'azerty')
