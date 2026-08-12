#!/usr/bin/env node
/**
 * Build & publish a GitHub release for the in-app updater (src/main/update-manager.ts).
 *
 * Produces (in release/hot/):
 *   agents-<version>.asar.gz — hot package: gzipped app.asar (pure JS, arch-independent)
 *   latest.json              — update manifest { version, notes, runtime, hot, full? }
 * and with --full also the DMG/zip installers (release/agents-<version>-<arch>.*).
 *
 * Usage:
 *   pnpm release --dry-run [--full]     build + stage only, print what would upload
 *   pnpm release --notes "fix …"        hot-only release
 *   pnpm release --full --notes "…"     also build + upload full installers
 *
 * Enforced rules:
 *   - package.json version must be newer than the published latest.json
 *   - if `runtime` (electron + node-pty versions) changed vs the published
 *     manifest — or there is no published manifest yet — --full is required:
 *     a hot package cannot update native parts
 *
 * Signing: ad-hoc (identity=null) while the Developer ID cert is revoked
 * (2026-07-21). When a new cert lands, drop SIGN_OVERRIDES below so the yml's
 * signed + notarized flow applies (source .env first, see PACKAGING.md).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const full = flag('--full')
const dryRun = flag('--dry-run')

const die = (msg) => {
  console.error(`release: ${msg}`)
  process.exit(1)
}
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: 'inherit' })
const depVersion = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
const repo = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? die(`origin is not a GitHub remote: ${remote}`)
// must mirror update-manager's localRuntime() — electron pkg version IS process.versions.electron
const runtime = `electron@${depVersion('electron')} node-pty@${depVersion('node-pty')}`
const download = (asset) => `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(asset)}`

// ── guards against the published manifest ───────────────────────────────────
const manifestUrl =
  process.env['RELEASE_BASE_MANIFEST'] ?? `https://github.com/${repo}/releases/latest/download/latest.json`
let published = null
try {
  published = manifestUrl.startsWith('http')
    ? await (await fetch(manifestUrl, { redirect: 'follow' })).json()
    : JSON.parse(readFileSync(manifestUrl, 'utf8'))
} catch {
  /* no release yet */
}
if (published?.version === version) die(`version ${version} is already published — bump package.json first`)
if (!full && !published) die('no published release found — the first release must be --full')
if (!full && published.runtime !== runtime) {
  die(`native runtime changed (${published.runtime} → ${runtime}) — this release must be --full`)
}

// ── build ───────────────────────────────────────────────────────────────────
const SIGN_OVERRIDES = ['-c.mac.identity=null', '-c.mac.notarize=false']
rmSync(join(root, 'release'), { recursive: true, force: true }) // stale artifacts would pollute the asset list
run('pnpm', ['build'])
/** The packaged app must carry native binaries of ITS arch — a stale/mixed
 *  node-pty here means a broken installer, so fail loudly, never ship it. */
function verifyNativeArch(arch) {
  const appDir = join(root, 'release', arch === 'x64' ? 'mac' : 'mac-arm64')
  const native = join(appDir, 'Agent S.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release')
  const want = arch === 'x64' ? 'x86_64' : 'arm64'
  for (const bin of ['pty.node', 'spawn-helper']) {
    const got = execFileSync('lipo', ['-archs', join(native, bin)], { encoding: 'utf8' }).trim()
    if (got !== want) die(`${arch} package carries ${bin} built for ${got} — refusing to ship`)
  }
}

if (full) {
  // node-pty must be rebuilt per arch before packaging that arch — a single
  // host-arch build would ship an arm64 pty.node inside the x64 installer.
  // arm64 (the host) goes last so node_modules is left usable for dev.
  for (const arch of ['x64', 'arm64']) {
    run('pnpm', ['exec', 'electron-rebuild', '-f', '-w', 'node-pty', '--arch', arch])
    run('pnpm', ['exec', 'electron-builder', '--mac', `--${arch}`, ...SIGN_OVERRIDES])
    verifyNativeArch(arch)
  }
} else {
  run('pnpm', ['exec', 'electron-builder', '--mac', '--dir', ...SIGN_OVERRIDES])
}

// the asar is pure JS — identical across arches; take it from whichever app exists
const release = join(root, 'release')
const appDir = readdirSync(release).find((d) => d.startsWith('mac') && existsSync(join(release, d, 'Agent S.app')))
if (!appDir) die('no Agent S.app under release/mac*/ — electron-builder output missing')
const asarPath = join(release, appDir, 'Agent S.app', 'Contents', 'Resources', 'app.asar')
if (!existsSync(asarPath)) die(`app.asar not found at ${asarPath}`)

// ── stage hot package + manifest ────────────────────────────────────────────
const hotDir = join(release, 'hot')
mkdirSync(hotDir, { recursive: true })
const hotName = `${pkg.name}-${version}.asar.gz`
const gz = gzipSync(readFileSync(asarPath), { level: 9 })
writeFileSync(join(hotDir, hotName), gz)

const manifest = {
  version,
  notes: opt('--notes') || `v${version}`, // `||`: CI may pass an empty string
  pubDate: new Date().toISOString(),
  runtime,
  hot: { url: download(hotName), sha512: createHash('sha512').update(gz).digest('hex'), size: gz.length },
  // hot-only releases keep pointing at the last full installer
  ...(full ? { full: { url: download(`${pkg.name}-${version}-arm64.dmg`) } } : published?.full ? { full: published.full } : {})
}
writeFileSync(join(hotDir, 'latest.json'), JSON.stringify(manifest, null, 2))

const assets = [join(hotDir, hotName), join(hotDir, 'latest.json')]
if (full) {
  for (const f of readdirSync(release)) {
    if (f.includes(version) && (f.endsWith('.dmg') || f.endsWith('.zip'))) assets.push(join(release, f))
  }
}

console.log(`\nrelease v${version}  (runtime: ${runtime}${full ? ', full' : ', hot-only'})`)
for (const a of assets) console.log(`  ${a}`)
if (dryRun) {
  console.log('\n--dry-run: nothing uploaded. Manifest:')
  console.log(readFileSync(join(hotDir, 'latest.json'), 'utf8'))
  process.exit(0)
}

// ── upload ──────────────────────────────────────────────────────────────────
try {
  run('gh', ['release', 'create', `v${version}`, ...assets, '--title', `v${version}`, '--notes', manifest.notes])
  console.log(`\npublished: https://github.com/${repo}/releases/tag/v${version}`)
} catch {
  console.error('\ngh upload failed (not logged in?). Publish manually:')
  console.error(`  gh auth login`)
  console.error(`  gh release create v${version} ${assets.map((a) => `'${a}'`).join(' ')} --title v${version} --notes '…'`)
  process.exit(1)
}
