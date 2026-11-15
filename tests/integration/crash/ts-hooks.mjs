// Node module hooks (registered by writer.mjs) that let a plain `node` process import the app's
// TypeScript sources as they are, without a build step or an extra dependency. Node itself strips
// the types (`--experimental-strip-types`); this file adds the three things Vite does for the app
// and that Node does not:
//   - extensionless relative imports (`./errors`  ->  `./errors.ts`, `./dir` -> `./dir/index.ts`)
//   - the `@shared/*` path alias (see tsconfig.json / vitest.config.ts)
//   - `?raw` imports (the SQL migrations are bundled as strings), as a default-exported string
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHARED_DIR = new URL('../../../src/shared/', import.meta.url)

const isFile = (url) => {
  try {
    return statSync(fileURLToPath(url)).isFile()
  } catch {
    return false
  }
}

function withExtension(url) {
  if (isFile(url)) return url
  for (const suffix of ['.ts', '/index.ts']) {
    const candidate = new URL(url.href + suffix)
    if (isFile(candidate)) return candidate
  }
  return url
}

export async function resolve(specifier, context, nextResolve) {
  const aliased = specifier.startsWith('@shared/')
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  if (!aliased && !relative) return nextResolve(specifier, context)

  const [path, query = ''] = specifier.split('?')
  const base = aliased ? SHARED_DIR : context.parentURL
  const url = new URL(aliased ? path.slice('@shared/'.length) : path, base)
  if (query === 'raw') return { url: `${url.href}?raw`, format: 'module', shortCircuit: true }
  return nextResolve(withExtension(url).href, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('?raw')) {
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  }
  return nextLoad(url, context)
}
