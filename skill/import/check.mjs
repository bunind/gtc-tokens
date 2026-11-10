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

// synthetic repo: the two fixture files + borrowed node_modules
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-import-check-'))
fs.mkdirSync(path.join(tmp, 'app'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'components/ui'), { recursive: true })
fs.copyFileSync(path.join(HERE, 'fixture/globals.css'), path.join(tmp, 'app/globals.css'))
fs.copyFileSync(path.join(HERE, 'fixture/button.tsx'), path.join(tmp, 'components/ui/button.tsx'))
fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"gtc-import-fixture","version":"0.0.0"}\n')
fs.symlinkSync(path.join(DEPS, 'node_modules'), path.join(tmp, 'node_modules'), 'junction')

const out = path.join(tmp, 'gtc-import')
try {
  execFileSync(process.execPath, [path.join(HERE, 'import.mjs'), '--repo', tmp, '--out', out, '--json'], { stdio: ['ignore', 'pipe', 'inherit'] })

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

  console.log(`check OK — ${Object.keys(tokens).length} fixture tokens, all six assertions hold`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
