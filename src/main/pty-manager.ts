/**
 * One node-pty per session. Keeps a capped output ring buffer so terminals
 * mounted later (grid cards, focused view, pop-outs) can hydrate and then
 * follow the live stream without gaps (cumulative `end` offsets).
 */
import pty from 'node-pty'
import { EventEmitter } from 'node:events'
import type { PtySnapshot } from '../shared/ipc'

const BUFFER_CAP = 400_000 // chars per session

interface Entry {
  proc: pty.IPty
  chunks: string[]
  buffered: number
  /** cumulative length of everything ever written */
  end: number
  cols: number
  rows: number
}

export class PtyManager extends EventEmitter {
  private entries = new Map<string, Entry>()

  spawn(
    id: string,
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> }
  ): void {
    const cols = 100
    const rows = 30
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: opts.env
    })
    const entry: Entry = { proc, chunks: [], buffered: 0, end: 0, cols, rows }
    this.entries.set(id, entry)

    proc.onData((data) => {
      entry.chunks.push(data)
      entry.buffered += data.length
      entry.end += data.length
      while (entry.buffered > BUFFER_CAP && entry.chunks.length > 1) {
        entry.buffered -= entry.chunks.shift()!.length
      }
      this.emit('data', { id, data, end: entry.end })
    })
    proc.onExit(({ exitCode }) => {
      this.entries.delete(id)
      this.emit('exit', { id, exitCode })
    })
  }

  isAlive(id: string): boolean {
    return this.entries.has(id)
  }

  size(id: string): { cols: number; rows: number } {
    const e = this.entries.get(id)
    return e ? { cols: e.cols, rows: e.rows } : { cols: 100, rows: 30 }
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.proc.write(data)
  }

  /**
   * Submit a chat message to the claude TUI: bracketed paste (so multi-line
   * text is one input) followed, after a beat, by Enter. The delay matters —
   * a CR in the same write as the paste-end marker gets swallowed as part of
   * the paste and never submits.
   */
  submit(id: string, text: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.proc.write(`\x1b[200~${text}\x1b[201~`)
    setTimeout(() => this.entries.get(id)?.proc.write('\r'), 60)
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id)
    if (!e || (e.cols === cols && e.rows === rows)) return
    e.cols = cols
    e.rows = rows
    e.proc.resize(cols, rows)
    this.emit('resize', { id, cols, rows })
  }

  snapshot(id: string): PtySnapshot {
    const e = this.entries.get(id)
    if (!e) return { data: '', end: 0 }
    return { data: e.chunks.join(''), end: e.end }
  }

  kill(id: string): void {
    this.entries.get(id)?.proc.kill()
  }

  /** Kill and resolve once the process has actually exited (before moving its files). */
  killAndWait(id: string): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 3000) // safety net
      e.proc.onExit(() => {
        clearTimeout(t)
        resolve()
      })
      e.proc.kill()
    })
  }

  killAll(): void {
    for (const e of this.entries.values()) e.proc.kill()
    this.entries.clear()
  }
}
