import { useEffect, useRef, useState, type ReactNode } from 'react'

export type ChangeMode = 'preview' | 'commit'

const fmt = (v: number) => (Math.round(v * 100) / 100).toString()

interface NumProps {
  label?: ReactNode
  title?: string
  value: number | undefined // undefined = mixed
  onChange: (v: number, mode: ChangeMode) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** Figma-style numeric field: type a value, use arrow keys, or drag the label to scrub. */
export function NumInput({ label, title, value, onChange, min, max, step = 1, suffix = '', placeholder, disabled, className }: NumProps) {
  const [text, setText] = useState<string | null>(null)
  const scrub = useRef<{ x: number; v: number; moved: boolean } | null>(null)
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const shown = text ?? (value === undefined ? '' : fmt(value) + suffix)
  const commitText = () => {
    if (text === null) return
    const v = parseFloat(text.replace(',', '.'))
    setText(null)
    if (!Number.isNaN(v) && v !== value) onChange(clamp(v), 'commit')
  }
  return (
    <label className={'num ' + (className ?? '') + (disabled ? ' disabled' : '')} title={title}>
      {label != null && (
        <span
          className="num-label"
          onPointerDown={(e) => {
            if (disabled || value === undefined) return
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            scrub.current = { x: e.clientX, v: value, moved: false }
          }}
          onPointerMove={(e) => {
            const s = scrub.current
            if (!s) return
            const dx = e.clientX - s.x
            if (!s.moved && Math.abs(dx) < 2) return
            s.moved = true
            onChange(clamp(Math.round((s.v + dx * step) / step) * step), 'preview')
          }}
          onPointerUp={(e) => {
            const s = scrub.current
            scrub.current = null
            if (s?.moved) onChange(clamp(Math.round((s.v + (e.clientX - s.x) * step) / step) * step), 'commit')
          }}
        >
          {label}
        </span>
      )}
      <input
        value={shown}
        disabled={disabled}
        placeholder={value === undefined ? (placeholder ?? 'Mixed') : placeholder}
        onFocus={(e) => {
          setText(value === undefined ? '' : fmt(value))
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          else if (e.key === 'Escape') {
            setText(null)
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== undefined) {
            e.preventDefault()
            const base = text !== null && !Number.isNaN(parseFloat(text)) ? parseFloat(text) : value
            const v = clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * step)
            setText(fmt(v))
            onChange(v, 'commit')
          }
        }}
      />
    </label>
  )
}

export function TextInput({ value, onCommit, placeholder, className }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      className={'text-input ' + (className ?? '')}
      value={text ?? value}
      placeholder={placeholder}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onCommit(text)
        setText(null)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(null)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  title,
  className,
}: {
  value: T | undefined
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  title?: string
  className?: string
}) {
  return (
    <select className={'select ' + (className ?? '')} title={title} value={value ?? '__mixed'} onChange={(e) => onChange(e.target.value as T)}>
      {value === undefined && (
        <option value="__mixed" disabled>
          Mixed
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function IconBtn({
  children,
  onClick,
  title,
  active,
  disabled,
}: {
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
  title?: string
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button className={'icon-btn' + (active ? ' active' : '')} title={title} onClick={onClick} disabled={disabled} tabIndex={-1}>
      {children}
    </button>
  )
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <span>{title}</span>
        <div className="section-actions">{actions}</div>
      </div>
      {children}
    </div>
  )
}

/** Floating panel anchored beside the right sidebar; closes on outside click or Escape. */
export function Popover({ anchorY, onClose, children, title }: { anchorY: number; onClose: () => void; children: ReactNode; title?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(anchorY)
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 300
    setTop(Math.max(8, Math.min(anchorY - 40, window.innerHeight - h - 8)))
  }, [anchorY])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="popover-backdrop" onPointerDown={onClose} />
      <div ref={ref} className="popover" style={{ top }}>
        {title && <div className="popover-title">{title}</div>}
        {children}
      </div>
    </>
  )
}

// ---------- color ----------
export function hexToHsv(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let hue = 0
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6
    else if (max === g) hue = (b - r) / d + 2
    else hue = (r - g) / d + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return [hue, max ? d / max : 0, max]
}

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return ('#' + f(5) + f(3) + f(1)).toUpperCase()
}

export function normalizeHex(input: string): string | null {
  let h = input.trim().replace('#', '')
  if (/^[0-9a-fA-F]{1,2}$/.test(h)) h = h.length === 1 ? h.repeat(6) : h.repeat(3)
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return '#' + h.toUpperCase()
}

function useDrag(onMove: (fx: number, fy: number, final: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const calc = (e: React.PointerEvent, final: boolean) => {
    const r = ref.current!.getBoundingClientRect()
    onMove(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), final)
  }
  return {
    ref,
    onPointerDown: (e: React.PointerEvent) => {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      calc(e, false)
    },
    onPointerMove: (e: React.PointerEvent) => e.buttons === 1 && calc(e, false),
    onPointerUp: (e: React.PointerEvent) => calc(e, true),
  }
}

export function ColorPicker({
  color,
  opacity,
  onChange,
}: {
  color: string
  opacity: number
  onChange: (color: string, opacity: number, mode: ChangeMode) => void
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(color))
  // Keep hue stable while dragging through greys; resync when the color changes elsewhere.
  useEffect(() => {
    if (hsvToHex(...hsv) !== color.toUpperCase()) setHsv(hexToHsv(color))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color])
  const emit = (h: number, s: number, v: number, a: number, final: boolean) => {
    setHsv([h, s, v])
    onChange(hsvToHex(h, s, v), a, final ? 'commit' : 'preview')
  }
  const sv = useDrag((fx, fy, final) => emit(hsv[0], fx, 1 - fy, opacity, final))
  const hue = useDrag((fx, _fy, final) => emit(fx * 360, hsv[1], hsv[2], opacity, final))
  const alpha = useDrag((fx, _fy, final) => emit(hsv[0], hsv[1], hsv[2], Math.round(fx * 100) / 100, final))
  return (
    <div className="color-picker">
      <div className="cp-sv" {...sv} style={{ backgroundColor: `hsl(${hsv[0]},100%,50%)` }}>
        <div className="cp-thumb" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: color }} />
      </div>
      <div className="cp-slider cp-hue" {...hue}>
        <div className="cp-thumb" style={{ left: `${(hsv[0] / 360) * 100}%`, top: '50%' }} />
      </div>
      <div className="cp-slider cp-alpha" {...alpha}>
        <div className="cp-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${color})` }} />
        <div className="cp-thumb" style={{ left: `${opacity * 100}%`, top: '50%' }} />
      </div>
      <div className="row">
        <span className="cp-tag">Hex</span>
        <TextInput
          value={color.replace('#', '')}
          onCommit={(v) => {
            const hex = normalizeHex(v)
            if (hex) onChange(hex, opacity, 'commit')
          }}
        />
        <NumInput className="w56" value={Math.round(opacity * 100)} suffix="%" min={0} max={100} onChange={(v, m) => onChange(color, v / 100, m)} />
      </div>
      <div className="cp-swatches">
        {['#000000', '#FFFFFF', '#D9D9D9', '#F24822', '#FFA629', '#FFCD29', '#14AE5C', '#0D99FF', '#9747FF', '#FF24BD'].map((c) => (
          <button key={c} style={{ background: c }} title={c} onClick={() => onChange(c, opacity, 'commit')} />
        ))}
      </div>
    </div>
  )
}
