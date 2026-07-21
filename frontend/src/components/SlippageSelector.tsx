// Shared max-slippage pill row used by both the curve trade panel and the swap panel.
const DEFAULT_OPTIONS = [1, 3, 5]

export function SlippageSelector({
  value,
  onChange,
  options = DEFAULT_OPTIONS,
}: {
  value: number
  onChange: (pct: number) => void
  options?: number[]
}) {
  return (
    <span className="pill-row">
      {options.map((s) => (
        <button
          key={s}
          className="pill"
          style={s === value ? { borderColor: 'var(--accent-dim)', color: 'var(--text)' } : undefined}
          onClick={() => onChange(s)}
        >
          {s}%
        </button>
      ))}
    </span>
  )
}
