import { useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { useApp } from '@/stores/app'

/**
 * Launch-args field with a recent-values dropdown that opens on **focus** (not
 * just on click). Free text: you can type anything or pick a recent value.
 */
export function LaunchArgsInput({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  const recent = useApp((s) => s.recentLaunchArgs)
  const [open, setOpen] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const options = recent.filter((r) => r && r !== value.trim() && r.toLowerCase().includes(value.trim().toLowerCase()))

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        autoComplete="off"
        placeholder="--model opus"
        onChange={(e) => {
          setOpen(true)
          onChange(e.target.value)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => (blurTimer.current = setTimeout(() => setOpen(false), 120))}
      />
      {open && options.length > 0 && (
        <div className="bg-popover absolute z-50 mt-1 max-h-44 w-full overflow-auto rounded-md border p-1 shadow-md">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              className="hover:bg-accent block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm"
              // mousedown fires before blur — keep focus so the click registers
              onMouseDown={(e) => {
                e.preventDefault()
                clearTimeout(blurTimer.current)
                onChange(o)
                setOpen(false)
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
