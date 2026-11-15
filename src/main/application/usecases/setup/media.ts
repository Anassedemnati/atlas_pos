import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MEDIA_DIR_NAME } from '@shared/media'
import type { Template } from '../../../domain/config/template'
import type { Logger } from '../../../logger'
import type { DataPaths } from '../../../paths'

/** Product code -> the path stored in `products.image_path` (relative to the data directory). */
export type ProductImages = ReadonlyMap<string, string>

/**
 * A template catalogue's illustrations: `<templateMediaDir>/<template>/<code>.webp` of every product flagged with
 * an image is copied to `<data dir>/media/products/<code>.webp`. A flagged product whose file is missing, or cannot
 * be copied, simply has no image (it is only a picture: the setup goes on).
 */
export function installTemplateImages(
  template: Pick<Template, 'id' | 'products'>,
  templateMediaDir: string | undefined,
  paths: DataPaths,
  log: Logger
): ProductImages {
  const images = new Map<string, string>()
  if (!templateMediaDir) return images
  const target = join(paths.media, 'products')
  for (const product of template.products) {
    if (!product.image) continue
    const from = join(templateMediaDir, template.id, `${product.code}.webp`)
    try {
      if (!existsSync(from)) {
        log.warn('setup.template_image_missing', { template: template.id, code: product.code })
        continue
      }
      mkdirSync(target, { recursive: true })
      copyFileSync(from, join(target, `${product.code}.webp`))
      images.set(product.code, `${MEDIA_DIR_NAME}/products/${product.code}.webp`)
    } catch (error) {
      log.warn('setup.template_image_failed', { template: template.id, code: product.code, message: String(error) })
    }
  }
  return images
}
