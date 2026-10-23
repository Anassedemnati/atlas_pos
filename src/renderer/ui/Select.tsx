import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { cx } from './metrics'

export interface SelectOption<V extends string = string> {
  value: V
  label: ReactNode
  disabled?: boolean
}

export interface SelectProps<V extends string = string> {
  label: string
  value: V | null
  options: SelectOption<V>[]
  onChange: (value: V) => void
  placeholder?: string
  disabled?: boolean
  error?: string
  className?: string
}

/**
 * A choice among a few options, made for fingers: a 64 px field that opens a list of 64 px rows in a dialog
 * (the system drop-down is a tiny target and an unstyled popup). Same look in French, English and Arabic.
 */
export function Select<V extends string = string>({ label, value, options, onChange, placeholder, disabled, error, className }: SelectProps<V>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const id = useId()
  const current = options.find((option) => option.value === value)

  return (
    <div className={cx('field', error && 'field--error', className)}>
      <span className="field__label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className="field__box field__select"
        aria-haspopup="listbox"
        aria-labelledby={`${id}-label ${id}-value`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span id={`${id}-value`} className={cx('field__value', !current && 'field__value--placeholder')}>
          {current?.label ?? placeholder ?? t('common.choose')}
        </span>
        <Icon name="chevron" size={26} />
      </button>
      {error && (
        <p className="field__message field__message--error" role="alert">
          <Icon name="warning" size={20} />
          {error}
        </p>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={label} size="sm">
        <ul className="options" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li key={option.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                className={cx('options__item', option.value === value && 'options__item--selected')}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Icon name="check" size={28} strokeWidth={3} />}
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  )
}
