export const MODULES = ['tables', 'kitchen', 'menus', 'customers', 'stock', 'barcode', 'scale'] as const

export type ModuleKey = (typeof MODULES)[number]
