/**
 * In-app updates from GitHub Releases (published by scripts/release.mjs).
 * Each release carries:
 *   latest.json           — { version, notes, runtime, hot{url,sha512,size}, full?{url} }
 *   agents-<v>.asar.gz    — the hot package: gzipped app.asar (pure JS, arch-independent)
 *   agents-<v>-*.dmg/zip  — full installers (required when `runtime` changes)
 *
 * A hot update swaps Resources/app.asar and relaunches — that refreshes all app
 * code and bundled deps, but NOT the native parts (the Electron shell and the
 * asar-unpacked node-pty addon). `runtime` fingerprints exactly those; on
 * mismatch a hot swap would crash on ABI, so the user is sent to the full
 * installer instead.
 *
 * Test/e2e envs: AGENTS_UPDATE_MANIFEST_URL overrides the manifest location;
 * AGENTS_UPDATE_AUTO=1 runs one dialog-less check-and-apply, then exits
 * (0 applied/up-to-date, 2 check/apply failed, 3 native mismatch).
 */
import { app, dialog, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const REPO = 'aria0509/agents'
const MANIFEST_URL =
  process.env['AGENTS_UPDATE_MANIFEST_URL'] ?? `https://github.com/${REPO}/releases/latest/download/latest.json`
const AUTO = !!process.env['AGENTS_UPDATE_AUTO']

interface Manifest {
  version: string
  notes?: string
  /** native fingerprint, e.g. "electron@43.1.0 node-pty@1.1.0" */
  runtime: string
  hot?: { url: string; sha512: string; size?: number }
  full?: { url: string }
}

const TEXT = {
  'zh-Hant': {
    found: '發現新版本 {v}（目前 {c}）',
    install: '更新並重啟',
    later: '稍後',
    download: '前往下載',
    close: '關閉',
    nativeDetail: '這個版本更新了原生元件（Electron / node-pty），無法熱更新。請下載完整安裝包重新安裝。',
    upToDate: '已是最新版本（{v}）',
    checkFailed: '檢查更新失敗',
    applyFailed: '更新失敗',
    writeHint: '無法寫入應用程式檔案（可能位於唯讀位置）。請下載完整安裝包重新安裝。'
  },
  'zh-Hans': {
    found: '发现新版本 {v}（当前 {c}）',
    install: '更新并重启',
    later: '稍后',
    download: '前往下载',
    close: '关闭',
    nativeDetail: '这个版本更新了原生组件（Electron / node-pty），无法热更新。请下载完整安装包重新安装。',
    upToDate: '已是最新版本（{v}）',
    checkFailed: '检查更新失败',
    applyFailed: '更新失败',
    writeHint: '无法写入应用程序文件（可能位于只读位置）。请下载完整安装包重新安装。'
  },
  en: {
    found: 'Version {v} is available (current {c})',
    install: 'Update & restart',
    later: 'Later',
    download: 'Download',
    close: 'Close',
    nativeDetail:
      'This version updates native components (Electron / node-pty) and cannot be hot-applied. Please reinstall from the full package.',
    upToDate: 'Already up to date ({v})',
    checkFailed: 'Update check failed',
    applyFailed: 'Update failed',
    writeHint: 'Could not write the app bundle (possibly a read-only location). Please reinstall from the full package.'
  }
}
function text(): (typeof TEXT)['en'] {
  const l = app.getLocale()
  if (l.startsWith('zh')) return /TW|HK|MO|Hant/i.test(l) ? TEXT['zh-Hant'] : TEXT['zh-Hans']
  return TEXT['en']
}

/** "1.2.10" > "1.2.9" — numeric dot-segments, missing segments count as 0 */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

/** Must mirror scripts/release.mjs — the electron package version IS process.versions.electron. */
function localRuntime(): string {
  const req = createRequire(import.meta.url)
  const pty = req('node-pty/package.json') as { version: string }
  return `electron@${process.versions.electron} node-pty@${pty.version}`
}

export class UpdateManager {
  /** versions already offered (and declined) this run — the 4h timer must not nag */
  private prompted = new Set<string>()
  private busy = false

  /** onBeforeQuit: lets index.ts skip its "keep running in background?" dialog */
  constructor(private onBeforeQuit: () => void) {}

  /** startup + periodic checks; no-op in dev unless a manifest override is set */
  schedule(): void {
    if (!app.isPackaged && !process.env['AGENTS_UPDATE_MANIFEST_URL']) return
    if (AUTO) {
      void this.check(false)
      return
    }
    setTimeout(() => void this.check(false), 15_000)
    setInterval(() => void this.check(false), 4 * 3_600_000)
  }

  /** manual=true (tray) always reports an outcome and re-offers declined versions */
  async check(manual: boolean): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const res = await net.fetch(MANIFEST_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const manifest = (await res.json()) as Manifest
      if (typeof manifest.version !== 'string' || typeof manifest.runtime !== 'string') {
        throw new Error('malformed manifest')
      }
      const current = app.getVersion()
      if (!newer(manifest.version, current)) {
        console.log(`update: up to date (${current})`)
        if (AUTO) return app.exit(0)
        if (manual) await this.info(text().upToDate.replace('{v}', current))
        return
      }
      if (!manual && this.prompted.has(manifest.version)) return
      this.prompted.add(manifest.version)
      if (manifest.runtime !== localRuntime()) await this.offerFull(manifest)
      else await this.offerHot(manifest)
    } catch (e) {
      console.log('update: check failed —', String(e))
      if (AUTO) return app.exit(2)
      if (manual) await this.info(`${text().checkFailed}\n${String(e)}`)
    } finally {
      this.busy = false
    }
  }

  /** native runtime changed — hot swap would break on ABI, point at the installer */
  private async offerFull(manifest: Manifest): Promise<void> {
    console.log(`update: ${manifest.version} available but native runtime changed — full reinstall required`)
    if (AUTO) return app.exit(3)
    const t = text()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [t.download, t.later],
      defaultId: 0,
      cancelId: 1,
      message: t.found.replace('{v}', manifest.version).replace('{c}', app.getVersion()),
      detail: manifest.notes ? `${t.nativeDetail}\n\n${manifest.notes}` : t.nativeDetail
    })
    if (response === 0) void shell.openExternal(this.fullUrl(manifest))
  }

  private async offerHot(manifest: Manifest): Promise<void> {
    console.log(`update: ${manifest.version} available (hot)`)
    if (!AUTO) {
      const t = text()
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: [t.install, t.later],
        defaultId: 0,
        cancelId: 1,
        message: t.found.replace('{v}', manifest.version).replace('{c}', app.getVersion()),
        detail: manifest.notes ?? ''
      })
      if (response !== 0) return
    }
    await this.apply(manifest)
  }

  /** download → verify → gunzip → atomically swap Resources/app.asar → relaunch */
  private async apply(manifest: Manifest): Promise<void> {
    try {
      if (!manifest.hot) throw new Error('manifest has no hot package')
      if (!app.isPackaged) throw new Error('hot update needs a packaged build')
      const res = await net.fetch(manifest.hot.url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const gz = Buffer.from(await res.arrayBuffer())
      const digest = createHash('sha512').update(gz).digest('hex')
      if (digest !== manifest.hot.sha512.toLowerCase()) throw new Error('sha512 mismatch')
      const asar = gunzipSync(gz)
      const target = join(process.resourcesPath, 'app.asar')
      // paths containing ".asar" go through Electron's asar-aware fs — bypass
      // it for real file operations on the archive itself
      process.noAsar = true
      try {
        writeFileSync(`${target}.new`, asar)
        renameSync(`${target}.new`, target) // same volume — atomic
      } finally {
        process.noAsar = false
      }
      console.log(`update: applied ${manifest.version}`)
      if (AUTO) return app.exit(0)
      this.onBeforeQuit()
      app.relaunch()
      app.quit()
    } catch (e) {
      console.log('update: apply failed —', String(e))
      if (AUTO) return app.exit(2)
      const t = text()
      const writeIssue = /EACCES|EPERM|EROFS/.test(String(e))
      const { response } = await dialog.showMessageBox({
        type: 'error',
        buttons: [t.download, t.close],
        defaultId: 0,
        cancelId: 1,
        message: t.applyFailed,
        detail: writeIssue ? t.writeHint : String(e)
      })
      if (response === 0) void shell.openExternal(this.fullUrl(manifest))
    }
  }

  private fullUrl(manifest: Manifest): string {
    return manifest.full?.url ?? `https://github.com/${REPO}/releases/latest`
  }

  private info(message: string): Promise<unknown> {
    return dialog.showMessageBox({ type: 'info', message })
  }
}
