#!/usr/bin/env node
// The one check (:import §7) — shadcn's own button.tsx + a globals.css with
// @theme and .dark. Fails exactly when the router breaks.
// Usage: node check.mjs <deps-repo>   (any Tailwind v4 repo whose node_modules
// supply typescript/postcss/@tailwindcss/node; or set $GTC_DEPS)
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEPS = process.argv[2] || process.env.GTC_DEPS
if (!DEPS || !fs.existsSync(path.join(DEPS, 'node_modules')))
  { console.error('usage: node check.mjs <repo with node_modules holding typescript/postcss/@tailwindcss/node>'); process.exit(2) }

const globalsCss = fs.readFileSync(path.join(HERE, 'fixture/globals.css'), 'utf8')
const tmps = []
// synthetic repo: button.tsx + the given css files + borrowed deps (`links`: path in repo → path in DEPS)
function importRepo(cssFiles, links = { node_modules: 'node_modules' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-import-check-'))
  tmps.push(tmp)
  for (const [rel, text] of Object.entries({ ...cssFiles, 'components/ui/button.tsx': fs.readFileSync(path.join(HERE, 'fixture/button.tsx'), 'utf8') })) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), text)
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"gtc-import-fixture","version":"0.0.0"}\n')
  for (const [at, from] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(tmp, at)), { recursive: true })
    fs.symlinkSync(path.join(DEPS, from), path.join(tmp, at), 'junction')
  }
  const out = path.join(tmp, 'gtc-import')
  const counts = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'import.mjs'), '--repo', tmp, '--out', out, '--json'], { stdio: ['ignore', 'pipe', 'inherit'] }))
  return { out, counts }
}

try {
  const { out, counts } = importRepo({ 'app/globals.css': globalsCss })
  assert.ok(counts.shadcn, 'shadcn not detected on the inline-vars fixture')

  // flatten the emitted tree the way validate.py does
  const tokens = {}
  const merge = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (v && typeof v === 'object' && dst[k] && typeof dst[k] === 'object') merge(dst[k], v); else dst[k] = v } }
  const tree = {}
  const walkDir = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkDir(p); else if (e.name.endsWith('.json') && !e.name.startsWith('_')) merge(tree, JSON.parse(fs.readFileSync(p, 'utf8'))) } }
  walkDir(out)
  const flat = (node, pre) => { if (node && typeof node === 'object') { if ('$value' in node) { tokens[pre] = node; return } for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) flat(v, pre ? pre + '.' + k : k) } }
  flat(tree, '')

  // 1 — component.button.size exists with exactly three modes
  const size = tokens['component.button.size']
  assert.ok(size, 'component.button.size missing')
  const sizeModes = Object.keys(size.$extensions?.mode ?? {})
  assert.deepStrictEqual(sizeModes.sort(), ['large', 'medium', 'small'], `component.button.size modes: ${sizeModes}`)

  // 2 — theme.button.primary.surface with light and dark values
  const surf = tokens['theme.button.primary.surface']
  assert.ok(surf, 'theme.button.primary.surface missing')
  assert.ok(surf.$extensions?.mode?.light && surf.$extensions?.mode?.dark, 'theme.button.primary.surface lacks light/dark modes')

  // 3 — $value mirrors light / medium; 4 — no color $type under component.*
  for (const [name, t] of Object.entries(tokens)) {
    const m = t.$extensions?.mode ?? {}
    if (name.startsWith('theme.') && 'light' in m) assert.strictEqual(t.$value, m.light, `$value !== light on ${name}`)
    if (name.startsWith('component.') && 'medium' in m) assert.strictEqual(t.$value, m.medium, `$value !== medium on ${name}`)
    if (name.startsWith('component.')) assert.notStrictEqual(t.$type, 'color', `color token under component: ${name}`)
  }

  // 5 — ring colors captured: button's focus-visible:ring-ring/50 must surface
  // as a --ring-color binding (regression for the --tw-ring-color blind spot)
  const rep = JSON.parse(fs.readFileSync(path.join(out, '_import-report.json'), 'utf8'))
  assert.ok(rep.bindings.some(b => b.property === '--ring-color' && b.state === 'focus'),
    'no focus --ring-color binding in report — ring capture regressed')

  // 6 — validate.py exits 0 on the emitted tree
  execFileSync('python3', [path.join(HERE, '..', 'validate.py'), out], { stdio: ['ignore', 'pipe', 'inherit'] })

  // 7 — entry at a non-candidate path (walkFiles fallback; once a TDZ crash) with the shadcn
  // vars in an @imported file (once missed: shadcn detected from the entry text only)
  const [head, ...vars] = globalsCss.split('\n')
  const split = importRepo({ 'src/css/main.css': head + '\n@import "./theme.css";\n', 'src/css/theme.css': vars.join('\n') })
  assert.ok(split.counts.shadcn, 'shadcn not detected when the vars live in an @imported file')
  assert.strictEqual(split.counts.unnamedRole, rep.unnamedRole.length, 'split entry yields different unnamed roles than inline')

  // 8 — pnpm layout: only the direct dep (tailwindcss) is linked at the top; postcss,
  // @tailwindcss/node and typescript sit in node_modules/.pnpm/node_modules
  importRepo({ 'app/globals.css': globalsCss }, {
    'node_modules/tailwindcss': 'node_modules/tailwindcss',
    'node_modules/.pnpm/node_modules': 'node_modules',
  })

  const wired = fs.readFileSync(path.join(out, '_wired/components/ui/button.tsx'), 'utf8')
  assert.match(wired, /h-\(--component-button-size\)/, 'button height not wired to component.button.size')
  assert.match(wired, /data-component='button' data-size=\{new Map\(.*\['sm','small'\].*\)\.get\(size \?\? 'default'\)\}/, 'button lacks data-size')
  assert.deepStrictEqual(size.$extensions.mode, { small: '{global.size-unit.32}', medium: '{global.size-unit.36}', large: '{global.size-unit.40}' }, 'button size per mode')

  console.log(`check OK — ${Object.keys(tokens).length} fixture tokens, all nine assertions hold`)
} finally {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true })
}
