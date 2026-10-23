import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../ui'
import { imageUrl } from '../format'

/** A product photo (or a placeholder when there is none or it cannot be loaded). */
export function Photo({ path, size = 48 }: { path: string | null; size?: number }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState<string | null>(null)
  const url = imageUrl(path)
  const style = { inlineSize: size, blockSize: size }
  if (!url || broken === path) {
    return (
      <span className="bo-photo bo-photo--empty" style={style} title={t('bo.products.noPhoto')}>
        <Icon name="store" size={Math.round(size / 2)} />
      </span>
    )
  }
  return <img className="bo-photo" style={style} src={url} alt="" onError={() => setBroken(path)} />
}
