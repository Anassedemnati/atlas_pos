import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'
import { cx } from './metrics'

export interface StepperProps {
  /** The step names, in order. */
  steps: string[]
  /** Index of the current step (0 for the first). */
  current: number
  className?: string
}

/** The wizard's vertical step list: done (check), current (teal), to come (grey), joined by a line. */
export function Stepper({ steps, current, className }: StepperProps) {
  const { t } = useTranslation()
  return (
    <ol className={cx('stepper', className)} aria-label={t('stepper.label')}>
      {steps.map((name, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li key={`${index}-${name}`} className={cx('stepper__step', `stepper__step--${state}`)} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="stepper__dot" aria-hidden="true">
              {state === 'done' ? <Icon name="check" size={26} strokeWidth={3} /> : index + 1}
            </span>
            <span className="stepper__name">{name}</span>
            {state === 'done' && <span className="sr-only">{t('stepper.done')}</span>}
          </li>
        )
      })}
    </ol>
  )
}
