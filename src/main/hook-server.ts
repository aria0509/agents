/**
 * Localhost HTTP sink for hook/statusline events injected into every claude
 * session via --settings. Routes: POST /e/<ourSessionId>/<event>
 */
import http from 'node:http'
import { EventEmitter } from 'node:events'

export interface HookEvent {
  sessionId: string
  event: string // SessionStart | UserPromptSubmit | Stop | Notification | statusline
  payload: Record<string, unknown>
}

export class HookServer extends EventEmitter {
  private server: http.Server
  port = 0

  /** statuslineText: what claude renders as the session's statusline */
  constructor(private statuslineText: (sessionId: string) => string) {
    super()
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as { port: number }).port
        resolve()
      })
    })
  }

  stop(): void {
    this.server.close()
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const m = /^\/e\/([\w-]+)\/(\w+)$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) {
      res.statusCode = 404
      res.end()
      return
    }
    const [, sessionId, event] = m
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(body)
      } catch {
        /* keep {} */
      }
      this.emit('event', { sessionId, event, payload } satisfies HookEvent)
      res.end(event === 'statusline' ? this.statuslineText(sessionId) : 'ok')
    })
  }
}
