/** A compact on/off switch for a table cell (the kit's Toggle is a full row). `label` is the accessible name. */
export function Switch({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={checked ? 'bo-switch bo-switch--on' : 'bo-switch'} data-testid={testId} onClick={() => onChange(!checked)}>
      <span className="bo-switch__knob" />
    </button>
  )
}
