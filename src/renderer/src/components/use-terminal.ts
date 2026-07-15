import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const THEME = {
  background: '#1a1a1a',
  foreground: '#e4e4e4',
  cursor: '#e4e4e4',
  selectionBackground: '#4a4a4a'
}

/**
 * Mounts an xterm bound to a session's pty stream. Hydrates from the main
 * process ring buffer, then follows live chunks (deduped via `end` offsets).
 * interactive=true additionally wires keyboard input and drives pty resize.
 */
export function useTerminal(
  sessionId: string,
  container: React.RefObject<HTMLDivElement | null>,
  opts: { interactive: boolean; fontSize?: number }
): void {
  const { interactive, fontSize = 13 } = opts
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const el = container.current
    if (!el || !sessionId) return

    const term = new Terminal({
      fontSize,
      fontFamily: 'Menlo, Monaco, monospace',
      theme: THEME,
      cursorBlink: interactive,
      disableStdin: !interactive,
      scrollback: interactive ? 5000 : 200
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    let hydratedTo = -1
    const queue: { data: string; end: number }[] = []

    const unsubscribe = window.api.onPtyData((ev) => {
      if (ev.id !== sessionId) return
      if (hydratedTo < 0) queue.push(ev)
      else if (ev.end > hydratedTo) term.write(ev.data)
    })

    void window.api.ptySnapshot(sessionId).then((snap) => {
      term.write(snap.data)
      hydratedTo = snap.end
      for (const ev of queue) if (ev.end > hydratedTo) term.write(ev.data)
      queue.length = 0
    })

    let disposeInput: { dispose(): void } | undefined
    let observer: ResizeObserver | undefined
    if (interactive) {
      disposeInput = term.onData((data) => void window.api.ptyWrite(sessionId, data))
      const applyFit = (): void => {
        fit.fit()
        if (term.cols && term.rows) void window.api.ptyResize(sessionId, term.cols, term.rows)
      }
      observer = new ResizeObserver(applyFit)
      observer.observe(el)
      applyFit()
      // don't steal focus from the chat input on activate — click the terminal to type
    } else {
      fit.fit()
    }

    return () => {
      unsubscribe()
      disposeInput?.dispose()
      observer?.disconnect()
      term.dispose()
    }
  }, [sessionId, interactive, fontSize, container])
}
