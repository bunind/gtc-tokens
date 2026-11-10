#!/usr/bin/env node
/**
 * /gtc-tokens:import — extract a GTC token set from a Tailwind v4 (+ shadcn) repo.
 *
 * Usage: node import.mjs --repo <path> [--css <entry.css>] [--out <dir>] [--only <subdir>]
 *                        [--ts <dir with a classic-API typescript>] [--json]
 *
 * scanClasses (AST) collects the class inventory and attributes each class to a
 * component / cva variant / cva size. compileCss compiles Tailwind against
 * exactly that inventory; walkCss reads the emitted rules. Joined on class name, routed
 * into GTC, written as a DTCG tree + loss report (<out>/_import-report.json).
 *
 * ponytail: zero new deps — typescript, postcss and @tailwindcss/node resolve
 * out of the target repo; every Tailwind v4 + shadcn repo ships all three.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

// ---------- cli ----------
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const REPO = path.resolve(arg('repo', '.'))
const OUT = path.resolve(arg('out', path.join(REPO, 'gtc-import')))
const ONLY = arg('only')          // e.g. --only components/ui: scope the class scan, keep docs chrome out
const TS_FROM = path.resolve(arg('ts', REPO))   // a dir whose node_modules holds a classic-API typescript
const JSON_ONLY = process.argv.includes('--json')

function die(msg) { console.error('error: ' + msg); process.exit(2) }
if (!fs.existsSync(REPO)) die(`repo not found: ${REPO}`)

// ---------- repo deps ----------
let req
try { req = createRequire(path.join(REPO, 'package.json')) } catch { die(`no package.json in ${REPO}`) }
function dep(name) { try { return req(name) } catch { return null } }
const postcss = dep('postcss')
const twNode = dep('@tailwindcss/node')
if (!postcss) die('target repo has no `postcss` installed — run npm install there first')

// scanClasses needs the classic compiler API (createSourceFile + forEachChild + the is* guards).
// TypeScript 7 is the native port: its npm package exports only `version`, and the AST moved to
// `typescript/unstable/*`, where parsing goes through a project/snapshot handle API instead.
// ponytail: resolve a classic TypeScript from --ts and say so when there is none, rather than
// porting the scan onto an `unstable` surface. Port it when TS 7 is the only line left.
const tsReq = TS_FROM === REPO ? req : createRequire(path.join(TS_FROM, 'package.json'))
let ts = null
try { ts = tsReq('typescript') } catch {}
if (!ts) die(`no \`typescript\` resolvable from ${TS_FROM} — run npm install there first`)
if (typeof ts.createSourceFile !== 'function')
  die(`\`typescript\` at ${TS_FROM} is version ${ts.version ?? '7+'}, which no longer exposes the\n`
    + `       classic compiler API the class scan needs. Install a classic-API TypeScript in any\n`
    + `       directory and point the scan at it, leaving the target repo untouched:\n\n`
    + `         mkdir -p /tmp/gtc-ts && cd /tmp/gtc-ts && npm init -y && npm i typescript@6\n`
    + `         node import.mjs --repo ${REPO} --ts /tmp/gtc-ts`)

// ---------- css entry + v4 gate ----------
const CSS_CANDIDATES = ['app/globals.css', 'src/app/globals.css', 'styles/globals.css',
  'src/styles/globals.css', 'app/index.css', 'src/index.css', 'src/app.css']
function findCss() {
  const given = arg('css')
  if (given) {
    const p = path.resolve(given)
    if (!fs.existsSync(p)) die(`css entry not found: ${p}`)
    return p
  }
  for (const rel of CSS_CANDIDATES) {
    const p = path.join(REPO, rel)
    if (fs.existsSync(p)) return p
  }
  for (const f of walkFiles(REPO, ['.css']))
    if (/@import\s+["']tailwindcss/.test(fs.readFileSync(f, 'utf8'))) return f
  die('no Tailwind CSS entry found — pass --css <path>')
}
const ENTRY = findCss()
const entryCss = fs.readFileSync(ENTRY, 'utf8')
if (/@tailwind\s+(base|components|utilities)/.test(entryCss))
  die('Tailwind v3 setup detected (`@tailwind base`). :import is v4-only — upgrade the repo to v4 first.')
if (!/@import\s+["']tailwindcss/.test(entryCss))
  die(`${path.relative(REPO, ENTRY)} does not \`@import "tailwindcss"\` — not a Tailwind v4 entry. Pass --css <path>.`)
const SHADCN = /--(background|primary)\s*:/.test(entryCss) ||
  /@theme[^{]*\{[^}]*--color-(background|primary)\s*:/s.test(entryCss)

// ---------- shared helpers ----------
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'public', 'vendor'])
function* walkFiles(dir, exts) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walkFiles(p, exts)
    else if (exts.includes(path.extname(e.name))) yield p
  }
}
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
function fmtNum(n) {
  const r = Math.round(n * 1000) / 1000
  return String(r)
}
function toPx(v) {
  const m = /^(-?[\d.]+)(px|rem|em)?$/.exec(String(v).trim())
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n
}

// ---------- color → hex ----------
function clamp255(x) { return Math.max(0, Math.min(255, Math.round(x * 255))) }
function hex2(n) { return n.toString(16).padStart(2, '0') }
function srgb(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055 }
function oklchToRgb(L, C, H) {
  const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map(srgb)
}
function hslToRgb(h, s, l) {
  const f = n => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}
function cssColorToHex(v) {
  v = String(v).trim()
  let m
  if ((m = /^#([0-9a-fA-F]{3,8})$/.exec(v))) {
    let h = m[1].toLowerCase()
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('')
    return '#' + h
  }
  if ((m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+%?|none)\s+(-?[\d.]+(?:deg)?|none)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(v))) {
    const L = parseFloat(m[1]) / (m[2] ? 100 : 1)
    const C = m[3] === 'none' ? 0 : m[3].endsWith('%') ? parseFloat(m[3]) * 0.004 : parseFloat(m[3])   // 100% = 0.4
    const H = m[4] === 'none' ? 0 : parseFloat(m[4])
    const [r, g, b] = oklchToRgb(L, C, H)
    let hex = '#' + hex2(clamp255(r)) + hex2(clamp255(g)) + hex2(clamp255(b))
    if (m[5]) {
      const a = m[5].endsWith('%') ? parseFloat(m[5]) / 100 : parseFloat(m[5])
      if (a < 1) hex += hex2(clamp255(a))
    }
    return hex
  }
  if ((m = /^hsl\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(v))) {
    const [r, g, b] = hslToRgb(parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100)
    let hex = '#' + hex2(clamp255(r)) + hex2(clamp255(g)) + hex2(clamp255(b))
    if (m[4]) {
      const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      if (a < 1) hex += hex2(clamp255(a))
    }
    return hex
  }
  if ((m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(v))) {
    const ch = x => Math.max(0, Math.min(255, Math.round(parseFloat(x))))
    let hex = '#' + hex2(ch(m[1])) + hex2(ch(m[2])) + hex2(ch(m[3]))
    if (m[4]) {
      const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      if (a < 1) hex += hex2(clamp255(a))
    }
    return hex
  }
  if (v === 'white') return '#ffffff'
  if (v === 'black') return '#000000'
  if (v === 'transparent') return '#00000000'
  return null
}

// =========================================================================
// scanClasses — AST class inventory
// =========================================================================
const CLASS_FNS = new Set(['cn', 'clsx', 'cx', 'classNames', 'twMerge', 'twJoin', 'tw', 'cls'])
const CVA_FNS = new Set(['cva', 'tv'])
const SIZE_KEYS = {
  '2xs': '2xsmall', xs: 'xsmall', sm: 'small', default: 'medium', md: 'medium',
  base: 'medium', lg: 'large', xl: 'xlarge', '2xl': '2xlarge',
}
const VARIANT_KEYS = { default: 'primary', destructive: 'danger', error: 'danger' }

function scanClasses() {
  const classes = new Map()   // class -> [{element, classifier, size, rawSize, file, line}]
  const unreachable = []      // {file, line, expr, element}
  const compounds = []        // {file, line, element}
  const unknownSizes = []     // {key, element, file, line}

  const srcRoot = ONLY ? path.join(REPO, ONLY) : REPO
  if (ONLY && !fs.existsSync(srcRoot)) die(`--only path not found: ${srcRoot}`)
  for (const file of walkFiles(srcRoot, ['.tsx', '.jsx', '.ts', '.js', '.mjs'])) {
    const text = fs.readFileSync(file, 'utf8')
    if (!/class(Name)?\s*[=:{"']|\bcva\s*\(|\btv\s*\(/.test(text)) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const rel = path.relative(REPO, file)
    const fileElem = kebab(path.basename(file).replace(/\.[^.]+$/, ''))
    const cvaVars = new Set()
    const line = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

    const add = (str, attr) => {
      for (const c of String(str).split(/\s+/)) {
        if (!c || c.length > 150) continue
        if (!classes.has(c)) classes.set(c, [])
        classes.get(c).push(attr)
      }
    }
    const propName = p => {
      if (!p || !p.name) return null
      if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return p.name.text
      return null
    }
    const calleeName = c => {
      const e = c.expression
      if (ts.isIdentifier(e)) return e.text
      if (ts.isPropertyAccessExpression(e)) return e.name.text
      return null
    }
    const enclosingElement = node => {
      for (let n = node; n; n = n.parent) {
        let nm = null
        if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) nm = n.name.text
        else if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.parent &&
          ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) nm = n.parent.name.text
        else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) nm = n.name.text
        if (nm) {
          const m = /^(.+)Variants$/.exec(nm)
          if (m) return kebab(m[1])
          if (/^[A-Z]/.test(nm)) return kebab(nm)
        }
      }
      return fileElem
    }

    function collectFrom(node, attr) {
      if (!node) return
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return add(node.text, attr)
      if (ts.isTemplateExpression(node)) {
        add(node.head.text, attr)
        for (const s of node.templateSpans) { add(s.literal.text, attr); collectFrom(s.expression, attr) }
        return
      }
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)))
        return collectFrom(node.expression, attr)
      if (ts.isConditionalExpression(node)) { collectFrom(node.whenTrue, attr); collectFrom(node.whenFalse, attr); return }
      if (ts.isBinaryExpression(node)) { collectFrom(node.left, attr); collectFrom(node.right, attr); return }
      if (ts.isArrayLiteralExpression(node)) { node.elements.forEach(e => collectFrom(e, attr)); return }
      if (ts.isObjectLiteralExpression(node)) {
        for (const p of node.properties) {           // clsx object form — key is the class
          const k = propName(p)
          if (k) add(k, attr)
        }
        return
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node)
        if (CVA_FNS.has(name)) return collectCva(node, attr)
        if (CLASS_FNS.has(name)) { node.arguments.forEach(a => collectFrom(a, attr)); return }
        // cva variant fns are harvested at their definition (here or another file);
        // any other call is a blind spot — report it instead of dropping silently
        if (!cvaVars.has(name) && !/Variants$/.test(name || ''))
          unreachable.push({ file: rel, line: line(node), expr: (name || '<call>') + '()', element: attr.element })
        return
      }
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        const name = ts.isIdentifier(node) ? node.text : node.name.text
        if (name !== 'className' && name !== 'class' && !cvaVars.has(name))
          unreachable.push({ file: rel, line: line(node), expr: name, element: attr.element })
        return
      }
    }

    function collectCva(call, attr) {
      collectFrom(call.arguments[0], attr)   // base classes
      const cfg = call.arguments[1]
      if (!cfg || !ts.isObjectLiteralExpression(cfg)) return
      for (const p of cfg.properties) {
        const key = propName(p)
        if (key === 'variants' && p.initializer && ts.isObjectLiteralExpression(p.initializer)) {
          for (const axisP of p.initializer.properties) {
            const axis = propName(axisP)
            if (!axisP.initializer || !ts.isObjectLiteralExpression(axisP.initializer)) continue
            for (const valP of axisP.initializer.properties) {
              const k = propName(valP)
              const a = { ...attr, line: line(valP) }
              if (axis === 'size') {
                a.size = SIZE_KEYS[k] ?? null
                a.rawSize = k
                // `icon` is shadcn's square-button variant, not a size-scale mode — known, not unknown
                if (!a.size && k !== 'icon') unknownSizes.push({ key: k, element: attr.element, file: rel, line: line(valP) })
              } else if (axis === 'variant' || axis === 'intent' || axis === 'color') {
                a.classifier = VARIANT_KEYS[k] ?? k
              } else { a.extraAxis = `${axis}=${k}` }
              collectFrom(valP.initializer, a)
            }
          }
        } else if (key === 'compoundVariants' && p.initializer && ts.isArrayLiteralExpression(p.initializer)) {
          compounds.push({ file: rel, line: line(p), element: attr.element })
          for (const el of p.initializer.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue
            for (const q of el.properties) {
              const qn = propName(q)
              if (qn === 'class' || qn === 'className') collectFrom(q.initializer, { ...attr, compound: true })
            }
          }
        }
      }
    }

    const visit = node => {
      if (ts.isJsxAttribute(node)) {
        const an = node.name.getText(sf)
        if (an === 'className' || an === 'class') {
          const attr = { element: enclosingElement(node), file: rel, line: line(node) }
          const init = node.initializer
          if (init) collectFrom(ts.isJsxExpression(init) ? init.expression : init, attr)
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        CVA_FNS.has((() => { const e = node.initializer.expression; return ts.isIdentifier(e) ? e.text : null })())) {
        if (ts.isIdentifier(node.name)) cvaVars.add(node.name.text)
        collectCva(node.initializer, { element: enclosingElement(node), file: rel, line: line(node) })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { classes, unreachable, compounds, unknownSizes }
}

// =========================================================================
// compileCss + walkCss — Tailwind compile, then walk emitted rules
// =========================================================================
async function compileCss(candidates) {
  if (twNode) {
    let compiler
    // An `@import` the entry makes of a package (`tw-animate-css`, a workspace CSS export)
    // fails here with a resolver stack and no hint. Every error ends in a command.
    try {
      compiler = await twNode.compile(entryCss, { base: path.dirname(ENTRY), onDependency() {} })
    } catch (e) {
      const miss = /Can't resolve '([^']+)'/.exec(e.message)?.[1]
      if (!miss) throw e
      die(`the CSS entry imports \`${miss}\`, which is not installed in the target repo:\n\n`
        + `         ${ENTRY}\n\n`
        + `       Install the repo's own dependencies, then re-run:\n\n`
        + `         cd ${REPO} && npm install`)
    }
    return compiler.build(candidates)
  }
  // ponytail: fallback when @tailwindcss/node is absent — proxy entry next to the
  // real one so relative @imports resolve, then npx the v4 CLI.
  const dir = path.dirname(ENTRY)
  const proxy = path.join(dir, '.gtc-import-entry.css')
  const content = path.join(dir, '.gtc-import-candidates.txt')
  fs.writeFileSync(content, candidates.join('\n'))
  fs.writeFileSync(proxy, `@import "./${path.basename(ENTRY)}";\n@source "./${path.basename(content)}";\n`)
  try {
    const out = path.join(dir, '.gtc-import-out.css')
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', '@tailwindcss/cli@4', '-i', proxy, '-o', out], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] })
    const css = fs.readFileSync(out, 'utf8')
    fs.unlinkSync(out)
    return css
  } finally { fs.unlinkSync(proxy); fs.unlinkSync(content) }
}

const STATE_MAP = [
  ['hover', 'hover'], ['focus-visible', 'focus'], ['focus-within', 'focus'],
  ['focus', 'focus'], ['active', 'active'], ['disabled', 'disabled'],
]
function walkCss(css, candidateSet) {
  const root = postcss.parse(css)
  const vars = { light: new Map(), dark: new Map() }    // --name -> value
  const hits = []            // {cls, prop, value, mode, state, important}
  const skippedSelectors = new Set()

  const fullSelectors = rule => {
    let sels = rule.selectors
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type !== 'rule') continue              // climb through at-rules (@media hover, @supports)
      const ps = p.selectors
      sels = ps.flatMap(a => sels.map(s => (s.includes('&') ? s.replace(/&/g, a) : a + ' ' + s)))
    }
    return sels
  }
  const atContext = rule => {
    let dark = false
    for (let p = rule.parent; p; p = p.parent) {
      if (p.type !== 'atrule') continue
      if (p.name === 'media' && /prefers-color-scheme:\s*dark/.test(p.params)) dark = true
      else if (p.name === 'supports' && !p.params.includes('color-mix')) return { skip: true }
      else if (/keyframes/.test(p.name)) return { skip: true }
      else if (p.name === 'media' && !/prefers-color-scheme|hover:\s*hover/.test(p.params)) return { skip: true }
    }
    return { dark }
  }
  // decls of a rule; nested @supports(color-mix) branch overrides the fallback (§3 ec3)
  const collectDecls = (container, map) => {
    for (const n of container.nodes || []) {
      if (n.type === 'decl') map.set(n.prop, n.value)
      else if (n.type === 'atrule' && n.name === 'supports' && n.params.includes('color-mix')) collectDecls(n, map)
    }
  }
  const unesc = s => s.replace(/\\(.)/g, '$1')
  const targetClass = sel => {
    const re = /\.((?:\\.|[\w-])+)/g
    let best = null, m
    while ((m = re.exec(sel))) {
      const c = unesc(m[1])
      if (c !== 'dark' && c !== 'light' && candidateSet.has(c)) best = { cls: c, end: m.index + m[0].length }
    }
    return best
  }
  const tailState = tail => {
    let t = tail.trim().replace(/:is\(\.(dark|light)\s*\*\)/g, '')
    if (t === '') return { state: null }
    let state = null
    for (const [k, v] of STATE_MAP) if (t.includes(':' + k)) { state = v; break }
    const stripped = t
      .replace(/:(hover|focus-visible|focus-within|focus|active|disabled)/g, '')
      .replace(/\[disabled\]/g, '').replace(/:not\(\)/g, '').trim()
    if (stripped !== '') return { reject: true }
    return { state }
  }

  root.walkRules(rule => {
    const at = atContext(rule)
    if (at.skip) return
    const decls = new Map()
    collectDecls(rule, decls)
    if (!decls.size) return
    for (const sel of fullSelectors(rule)) {
      const darkSel = /\.dark(\s|$|[.:[)])/.test(sel)
      const mode = at.dark || darkSel ? 'dark' : 'light'
      // custom-property table — any rule may define vars (:root, .dark, scope classes)
      for (const [p, v] of decls) {
        if (!p.startsWith('--') || p.startsWith('--tw-')) continue
        const nm = p.slice(2)
        // size-scope plumbing (`--x: var(--x-small)` under .size-* scopes) switches
        // modes at runtime — it is not a token definition; keep the base value
        const pm = /^var\(\s*--([\w-]+)\s*\)$/.exec(v.trim())
        if (pm && GTC_PREFIX.test(nm) && GTC_PREFIX.test(pm[1]) && gtcPath(nm).path === gtcPath(pm[1]).path) continue
        vars[mode].set(nm, v)
      }
      const target = targetClass(sel)
      if (!target) continue
      const { state, reject } = tailState(sel.slice(target.end))
      if (reject) { skippedSelectors.add(sel); continue }
      for (const [p, v] of decls) {
        // ring color rides a Tailwind-private var — surface it as --ring-color (COLOR_ID)
        if (p === '--tw-ring-color') { hits.push({ cls: target.cls, prop: '--ring-color', value: v, mode, state }); continue }
        if (p.startsWith('--') || p.startsWith('-webkit-') || p.startsWith('-moz-')) continue
        hits.push({ cls: target.cls, prop: p, value: v, mode, state })
      }
    }
  })
  return { vars, hits, skippedSelectors: [...skippedSelectors] }
}

// =========================================================================
// Resolution — var chains, calc, color-mix (§3 edge cases)
// =========================================================================
const GTC_PREFIX = /^(global|theme|component)-/
// multi-word levels kept whole when a CSS var name is re-dotted (§8 lossy gap)
const JOINED = ['size-unit', 'font-family', 'font-size', 'line-height', 'font-weight',
  'letter-spacing', 'spacing-gap', 'padding-inline', 'padding-block', 'padding-top',
  'padding-bottom', 'border-width', 'border-style', 'z-index', 'icon-size',
  'inverse-primary', 'inverse-secondary', 'inverse-tertiary', 'high-contrast',
  'min-width', 'max-width', 'min-height', 'max-height', 'underline-offset',
  // compound element names stay one level (a dot would invent fake levels)
  'alert-dialog', 'context-menu', 'dropdown-menu', 'navigation-menu', 'hover-card',
  'input-otp', 'radio-group', 'scroll-area', 'toggle-group', 'button-group',
  'input-group', 'item-group', 'chart-tooltip', 'aspect-ratio', 'alpha-base', 'alpha-red',
].sort((a, b) => b.length - a.length)
const SIZE_MODES = new Set(['2xsmall', 'xsmall', 'small', 'medium', 'large', 'xlarge', '2xlarge'])

function segs(name) {
  const parts = []
  let rest = name
  while (rest.length) {
    const hit = JOINED.find(j => rest === j || rest.startsWith(j + '-'))
    if (hit) { parts.push(hit); rest = rest.slice(hit.length + 1) }
    else {
      const i = rest.indexOf('-')
      if (i === -1) { parts.push(rest); rest = '' }
      else { parts.push(rest.slice(0, i)); rest = rest.slice(i + 1) }
    }
  }
  return parts.join('.')
}
// --component-button-spacing-gap-small → {path: component.button.spacing-gap, sizeMode: small}
function gtcPath(varName) {
  const dotted = segs(varName)
  const parts = dotted.split('.')
  if (parts[0] === 'component') {
    const last = parts[parts.length - 1]
    if (SIZE_MODES.has(last)) return { path: parts.slice(0, -1).join('.'), sizeMode: last }
    return { path: dotted, sizeMode: 'medium' }
  }
  return { path: dotted }
}

function makeResolver(vars) {
  function chase(name, mode, seen = new Set(), stopAtGtc = true) {
    if (stopAtGtc && GTC_PREFIX.test(name)) return { gtc: gtcPath(name) }
    if (seen.has(name)) return { unknownVar: name }
    seen.add(name)
    // deliberate cross-mode fallback: a var defined only in .dark still resolves
    // for light — a labeled value beats unmappable; put() flags real conflicts
    const v = (mode === 'dark' && vars.dark.get(name)) || vars.light.get(name) || vars.dark.get(name)
    if (v == null) return { unknownVar: name }
    const m = /^var\(\s*--([\w-]+)\s*(?:,\s*([^()]+))?\)$/.exec(v.trim())
    if (m) {
      const r = chase(m[1], mode, seen, stopAtGtc)
      if (!r.unknownVar) return r
      // ponytail: non-nested fallback only — var(--x, var(--y)) stays lossy
      if (m[2]) return { varName: name, value: m[2].trim() }
      return { varName: name, value: v }
    }
    return { varName: name, value: v.trim() }
  }
  function evalCalc(expr, mode, depth = 0) {
    if (depth > 4) return null                      // var→calc→var cycle guard
    // substitute vars with px numbers, then evaluate pure arithmetic
    let bad = false
    const sub = expr.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]+))?\)/g, (_, n, fb) => {
      const r = chase(n, mode)
      let px = r.value != null ? toPx(r.value) : null
      if (px == null && r.value && /^calc\(/.test(r.value) && r.value.endsWith(')'))
        px = evalCalc(r.value.slice(5, -1), mode, depth + 1)   // var defined as calc(…)
      if (px == null && fb) px = toPx(fb.trim())
      if (px == null) { bad = true; return '0' }
      return String(px)
    })
    if (bad) return null
    const clean = sub.replace(/calc\(/g, '(')       // nested calc() reads as plain parens
      .replace(/(-?[\d.]+)(px|rem|em)/g, (_, n, u) => String(u === 'px' ? +n : +n * 16))
    if (!/^[-+*/(). \d]+$/.test(clean)) return null
    try { return Function(`"use strict"; return (${clean})`)() } catch { return null }
  }
  // → {gtc:{path,sizeMode}} | {varName?, value} | {colorMix:{inner, pct}} | {calcPx} | {value} | {unknownVar}
  function resolve(raw, mode, stopAtGtc = true) {
    const v = String(raw).trim()
    let m
    if ((m = /^var\(\s*--([\w-]+)\s*(?:,\s*([^()]+))?\)$/.exec(v))) {
      const r = chase(m[1], mode, new Set(), stopAtGtc)
      if (r.unknownVar && m[2]) return resolve(m[2].trim(), mode, stopAtGtc)
      if (r.value && /^calc\(/.test(r.value) && r.value.endsWith(')')) {   // chain ends in calc (§3 ec1)
        const px = evalCalc(r.value.slice(5, -1), mode)
        if (px != null) return { calcPx: px, varName: r.varName }
      }
      return r
    }
    if ((m = /^color-mix\(in\s+[\w-]+,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(v))) {
      return { colorMix: { inner: resolve(m[1], mode), pct: Math.round(parseFloat(m[2])) } }
    }
    if (/^calc\(/.test(v) && v.endsWith(')')) {
      const px = evalCalc(v.slice(5, -1), mode)
      if (px != null) return { calcPx: px }
      return { value: v, opaque: true }
    }
    return { value: v }
  }
  return { resolve, chase }
}

// =========================================================================
// GTC router + tree
// =========================================================================
const STARTER = {
  'size-unit': new Set(['0', '1', '2', '4', '6', '8', '12', '16', '20', '24', '28', '32', '40', '44']),
  radius: new Set(['0', '4', '8', '12', '1000']),
  'font-size': new Set(['12', '14', '16', '18', '20', '24', '30']),
  border: new Set(['0', '1', '2', '4']),
}
const SHADCN_BRIDGE = {
  background: 'theme.surface.page', foreground: 'theme.text.default',
  card: 'theme.card.surface', 'card-foreground': 'theme.card.text',
  popover: 'theme.popover.surface', 'popover-foreground': 'theme.popover.text',
  primary: 'theme.button.primary.surface', 'primary-foreground': 'theme.button.primary.text',
  secondary: 'theme.button.secondary.surface', 'secondary-foreground': 'theme.button.secondary.text',
  muted: 'theme.surface.muted', 'muted-foreground': 'theme.text.muted',
  accent: 'theme.surface.accent', 'accent-foreground': 'theme.text.accent',
  destructive: 'theme.button.danger.surface', 'destructive-foreground': 'theme.button.danger.text',
  border: 'theme.border.default', input: 'theme.input.border', ring: 'theme.focus.ring',
  'chart-1': 'theme.chart.1', 'chart-2': 'theme.chart.2', 'chart-3': 'theme.chart.3',
  'chart-4': 'theme.chart.4', 'chart-5': 'theme.chart.5',
}
// what the compiled property means in GTC (§4)
const COLOR_ID = {
  'background-color': 'surface', color: 'text', 'border-color': 'border',
  'border-top-color': 'border', 'border-bottom-color': 'border',
  'border-left-color': 'border', 'border-right-color': 'border',
  'border-block-color': 'border', 'border-inline-color': 'border',
  'outline-color': 'outline', fill: 'icon', stroke: 'icon', 'caret-color': 'text',
  'text-decoration-color': 'text', '--ring-color': 'ring',
}
const DIM_ID = {
  'border-radius': 'radius', 'border-top-left-radius': 'radius', 'border-top-right-radius': 'radius',
  'border-bottom-left-radius': 'radius', 'border-bottom-right-radius': 'radius',
  'border-start-start-radius': 'radius', 'border-start-end-radius': 'radius',
  'border-end-start-radius': 'radius', 'border-end-end-radius': 'radius',
  gap: 'spacing-gap', 'column-gap': 'spacing-gap', 'row-gap': 'spacing-gap',
  height: 'size', width: 'width', 'min-height': 'size', 'min-width': 'min-width',
  'max-height': 'max-height', 'max-width': 'max-width',
  padding: 'padding', 'padding-inline': 'padding-inline', 'padding-block': 'padding-block',
  'padding-left': 'padding-inline', 'padding-right': 'padding-inline',
  'padding-top': 'padding-block', 'padding-bottom': 'padding-block',
  'padding-inline-start': 'padding-inline', 'padding-inline-end': 'padding-inline',
  'font-size': 'font-size', 'border-width': 'border',
  'border-top-width': 'border', 'border-bottom-width': 'border',
  'border-left-width': 'border', 'border-right-width': 'border',
  'border-block-width': 'border', 'border-inline-width': 'border',
  'margin-inline': 'margin-inline', 'margin-block': 'margin-block', margin: 'margin',
  'margin-left': 'margin-inline', 'margin-right': 'margin-inline',
  'margin-top': 'margin-block', 'margin-bottom': 'margin-block',
}
const DIM_SCALE = {
  'border-radius': 'global.radius', 'border-top-left-radius': 'global.radius',
  'border-top-right-radius': 'global.radius', 'border-bottom-left-radius': 'global.radius',
  'border-bottom-right-radius': 'global.radius', 'border-start-start-radius': 'global.radius',
  'border-start-end-radius': 'global.radius', 'border-end-start-radius': 'global.radius',
  'border-end-end-radius': 'global.radius', 'font-size': 'global.typography.font-size',
  'border-width': 'global.border', 'border-top-width': 'global.border',
  'border-bottom-width': 'global.border', 'border-left-width': 'global.border',
  'border-right-width': 'global.border', 'border-block-width': 'global.border',
  'border-inline-width': 'global.border', 'letter-spacing': 'global.typography.letter-spacing',
}
// properties that bind straight to global.* — no theme/component token (§4)
const GLOBAL_BIND = new Set(['font-weight', 'font-family', 'line-height', 'letter-spacing',
  'box-shadow', 'opacity', 'z-index', 'transition-duration', 'transition-timing-function',
  'backdrop-filter', 'border-style'])
const UNMAPPED_OK = new Set(['display', 'position', 'overflow', 'overflow-x', 'overflow-y',
  'align-items', 'justify-content', 'flex', 'flex-direction', 'flex-shrink', 'flex-grow', 'flex-wrap',
  'text-align', 'white-space', 'pointer-events', 'cursor', 'user-select', 'appearance',
  'text-decoration-line', 'text-overflow', 'outline-style', 'outline-offset', 'outline-width',
  'vertical-align', 'box-sizing', 'inset', 'top', 'right', 'bottom', 'left', 'visibility',
  'text-wrap', 'word-break', 'object-fit', 'aspect-ratio', 'grid-template-columns',
  'grid-template-rows', 'list-style', 'list-style-type', 'border', 'background-clip',
  'transition-property', 'transition-behavior', 'will-change', 'contain', 'isolation',
  'scroll-margin', 'scroll-padding', 'touch-action', 'resize', 'field-sizing',
  'font-variant-numeric', 'font-feature-settings', 'font-variation-settings',
  'text-transform', 'text-underline-offset', 'animation', 'transform', 'translate',
  'rotate', 'scale', 'filter', 'background-image', 'background-position', 'background-size',
  'mask-image', 'forced-color-adjust', 'color-scheme', 'interactivity', 'text-size-adjust',
  'inset-inline', 'inset-block', 'inset-inline-start', 'inset-inline-end',
  'container-type', 'container-name', 'clip-path', 'clip', 'order', 'flex-basis',
  'grid-column', 'grid-row', 'justify-self', 'align-self', 'place-items', 'place-content',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
  'transform-origin', 'scrollbar-width', 'overflow-wrap', 'word-wrap', 'hyphens',
  'border-top-style', 'border-bottom-style', 'border-left-style', 'border-right-style',
  'scroll-snap-type', 'scroll-snap-align', 'scroll-snap-stop', 'scrollbar-gutter',
  'overscroll-behavior', 'overscroll-behavior-x', 'overscroll-behavior-y',
  'justify-items', 'font-style', 'scroll-margin-top', 'scroll-margin-bottom',
  'scroll-margin-left', 'scroll-margin-right', 'scroll-margin-block', 'scroll-margin-inline',
  'scroll-padding-top', 'scroll-padding-bottom', 'scroll-padding-left', 'scroll-padding-right',
  'scroll-padding-block', 'scroll-padding-inline',
  'caption-side', 'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow',
  'contain-intrinsic-size', 'content-visibility', 'counter-increment', 'counter-reset',
  'border-block-style', 'border-inline-style'])
const WEIGHT_ROLE = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' }

function build(inventory, compiled, resolver) {
  const { resolve } = resolver
  const tokens = new Map()     // path -> {type, modes: Map, sources: Set, group}
  const report = {
    shadcn: SHADCN, repo: REPO, entry: path.relative(REPO, ENTRY), out: OUT,
    unreachable: inventory.unreachable, compoundVariants: inventory.compounds,
    unknownSizeKeys: inventory.unknownSizes, offScale: [], rawLiteral: [],
    nearDuplicate: [], unnamedRole: [], unmappable: [],
    bindings: [], skippedSelectors: compiled.skippedSelectors,
    conflicts: [], filledModes: [], classes: inventory.classes.size, cssHits: compiled.hits.length,
  }
  const put = (p, type, mode, value, source) => {
    if (!tokens.has(p)) tokens.set(p, { type, modes: new Map(), sources: new Set() })
    const t = tokens.get(p)
    if (t.modes.has(mode) && t.modes.get(mode) !== value) {
      report.conflicts.push({ token: p, mode, kept: t.modes.get(mode), dropped: value, from: source })
      return p
    }
    t.modes.set(mode, value)
    if (source) t.sources.add(source)
    return p
  }
  // global primitive registration — key is factual (§3 ec1/ec2)
  const putGlobal = (p, type, value, source) => {
    const existing = tokens.get(p)
    if (existing && existing.modes.get('light') !== value) {
      report.conflicts.push({ token: p, mode: 'light', kept: existing.modes.get('light'), dropped: value, from: source })
      return p
    }
    return put(p, type, 'light', value, source)
  }
  const globalColor = (varName, hex, source) => {
    const named = varName && /^color-(.+)$/.exec(varName)
    const p = named ? 'global.color.' + segs(named[1]) : 'global.color.raw.' + hex.slice(1)
    if (!named) report.offScale.push({ token: p, value: hex, from: source })
    return putGlobal(p, 'color', hex, source)
  }
  const globalDim = (prop, px, source) => {
    const scale = DIM_SCALE[prop] || 'global.size-unit'
    const n = fmtNum(px)
    const key = n.replace(/\./g, '-')      // 12.8px → key `12-8`: a dot would split levels
    const bucket = scale.split('.').pop()
    if (STARTER[bucket] && !STARTER[bucket].has(key)) report.offScale.push({ token: `${scale}.${key}`, value: `${n}px`, from: source })
    return putGlobal(`${scale}.${key}`, 'dimension', `${n}px`, source)
  }
  const globalOpacity = (pct, source) =>
    putGlobal(`global.color.opacity.${pct}`, 'number', pct / 100, source)

  // 1 — GTC-named custom properties transliterate directly
  for (const mode of ['light', 'dark']) {
    for (const [name, value] of compiled.vars[mode]) {
      if (!GTC_PREFIX.test(name)) continue
      const { path: p, sizeMode } = gtcPath(name)
      // global aliases nothing — chase a global var chain down to its literal
      const r = resolve(value, mode, !p.startsWith('global.'))
      const tokenMode = p.startsWith('component.') ? sizeMode : mode
      if (r.unknownVar) {
        report.unmappable.push({ token: p, value: `var(--${r.unknownVar}) unresolvable`, from: 'css var --' + name })
      } else if (r.gtc) {
        if (r.gtc.path !== p)                       // self-alias = scope plumbing, never a token
          put(p, aliasType(p, r.gtc.path), tokenMode, `{${r.gtc.path}}`, 'css var --' + name)
      } else if (r.calcPx != null) {
        if (p.startsWith('global.')) put(p, 'dimension', 'light', fmtNum(r.calcPx) + 'px', 'css var --' + name)
        else put(p, 'dimension', tokenMode, `{${globalDim(guessProp(p), r.calcPx, '--' + name)}}`, 'css var --' + name)
      } else if (r.value != null) {
        const v = r.value
        if (p.startsWith('global.')) {
          put(p, typeFor(p, v), 'light', normalizeGlobal(p, v), 'css var --' + name)
        } else {
          // theme/component never hold raws — mint the primitive first (§4 hard rule)
          const hex = cssColorToHex(v)
          const px = toPx(v)
          if (hex) put(p, 'color', tokenMode, `{${globalColor(null, hex, '--' + name)}}`, 'css var --' + name)
          else if (px != null) put(p, 'dimension', tokenMode, `{${globalDim(guessProp(p), px, '--' + name)}}`, 'css var --' + name)
          else report.unmappable.push({ token: p, value: v, from: 'css var --' + name })
        }
      }
    }
  }

  // 2 — shadcn cssVars with literal values → bridge inversion (§5 step 6)
  if (SHADCN) {
    for (const [name, bridged] of Object.entries(SHADCN_BRIDGE)) {
      for (const mode of ['light', 'dark']) {
        const v = compiled.vars[mode].get(name)
        if (v == null) continue
        const r = resolve(v, mode)
        if (r.gtc) continue                       // repo has its own GTC theme layer already
        const lit = r.value ?? v
        const hex = cssColorToHex(lit)
        if (hex) put(bridged, 'color', mode, `{${globalColor(r.varName && r.varName !== name ? r.varName : null, hex, '--' + name)}}`, 'css var --' + name)
      }
    }
    for (const mode of ['light', 'dark']) {
      for (const [name, v] of compiled.vars[mode]) {
        if (/^sidebar/.test(name) && !GTC_PREFIX.test(name)) {
          if (mode === 'light') report.unnamedRole.push({ var: '--' + name, value: v, why: 'region name — GTC names by design role, not screen area; propose a role' })
        }
      }
    }
    const rad = compiled.vars.light.get('radius')
    if (rad) { const px = toPx(rad); if (px != null) globalDim('border-radius', px, '--radius') }
  }

  // 3 — class hits → component / theme tokens + global bindings
  const darkDims = []
  for (const hit of compiled.hits) {
    const attrs = inventory.classes.get(hit.cls) || []
    const sample = attrs[0] || { element: null }
    const elements = [...new Set(attrs.map(a => a.element).filter(Boolean))]
    const el = elements[0] || 'shared'
    const src = `${hit.cls}${sample.file ? `, ${sample.file}:${sample.line}` : ''}`

    if (/\[[^\]]*\]/.test(hit.cls.replace(/^\S*?:/, '')) && /[[#\d]/.test(hit.cls)) {
      if (/\[(#|rgb|hsl|oklch|\d)/.test(hit.cls)) report.rawLiteral.push({ class: hit.cls, property: hit.prop, value: hit.value, from: src })
    }

    const r = resolve(hit.value, hit.mode)
    // runtime-measured library vars (Radix/Base UI popper sizes etc.) are never tokens
    if (r.unknownVar && /^((radix|reka|cmdk|vaul|bits)-|(anchor|available|trigger)-(width|height)$)/.test(r.unknownVar)) continue
    const colorId = COLOR_ID[hit.prop]
    const dimId = DIM_ID[hit.prop]

    // resolve to a global alias (+ optional opacity)
    let alias = null, alphaPct = null, rawPx = null
    if (r.gtc) alias = `{${r.gtc.path}}`
    else if (r.colorMix) {
      alphaPct = r.colorMix.pct
      const inner = r.colorMix.inner
      if (inner.gtc) alias = `{${inner.gtc.path}}`
      else if (inner.value != null) {
        const hex = cssColorToHex(inner.value)
        if (hex) alias = `{${globalColor(inner.varName, hex, src)}}`
      }
    } else if (r.calcPx != null) rawPx = r.calcPx
    else if (r.value != null && !r.opaque) {
      const hex = cssColorToHex(r.value)
      const px = toPx(r.value)
      if (hex) alias = `{${globalColor(r.varName, hex, src)}}`
      else if (px != null) rawPx = px
    }

    if (colorId) {
      if (!alias) {
        if (!['currentcolor', 'inherit', 'transparent', 'initial', 'canvas', 'canvastext'].includes(String(r.value || hit.value).toLowerCase()))
          report.unmappable.push({ class: hit.cls, property: hit.prop, value: hit.value, from: src })
        continue
      }
      if (r.gtc || (r.colorMix && r.colorMix.inner.gtc)) {
        // already themed in CSS — record binding only
        report.bindings.push({ element: el, classifier: sample.classifier || null, property: hit.prop, token: alias, state: hit.state, from: src })
      } else if (!SHADCN || !bridgeCovers(r, compiled)) {
        // raw-Tailwind color — needs a design role (§5 step 6: propose, never guess)
        const parts = ['theme', el]
        if (sample.classifier) parts.push(sample.classifier)
        parts.push(colorId)
        if (hit.state) parts.push(hit.state)
        const p = parts.join('.')
        put(p, 'color', hit.mode, alias, src)
        if (!SHADCN) report.unnamedRole.push({ token: p, class: hit.cls, property: hit.prop, from: src, why: 'role proposed from usage — confirm' })
      } else {
        report.bindings.push({ element: el, classifier: sample.classifier || null, property: hit.prop, token: bridgeTokenFor(r), state: hit.state, from: src })
      }
      if (alphaPct != null) {
        const parts = ['theme', el]
        if (sample.classifier) parts.push(sample.classifier)
        parts.push('alpha', hit.state || colorId)
        put(parts.join('.'), 'number', hit.mode, `{${globalOpacity(alphaPct, src)}}`, src)
      }
      continue
    }

    if (dimId) {
      // dimensions don't theme-switch; dark-scoped dim hits are skipped — collect
      // them so a dark-only dimension (no light counterpart) still shows as loss
      if (hit.mode === 'dark') { darkDims.push({ el, dimId, class: hit.cls, property: hit.prop, from: src }); continue }
      let a = alias
      if (!a && rawPx != null) a = `{${globalDim(hit.prop, rawPx, src)}}`
      // rounded-full emits calc(infinity * 1px) — the pill radius, 1000 on the starter scale
      if (!a && dimId === 'radius' && /infinity/.test(String(r.value ?? hit.value)))
        a = `{${globalDim(hit.prop, 1000, src)}}`
      if (!a) {
        const vv = String(r.value ?? hit.value).trim()
        // keywords, percentages, viewport units, %-mixed calc: layout values, not token material
        if (!/^(auto|none|inherit|initial|fit-content|min-content|max-content|0|[\d.]+%|[\d.]+[sld]?v[hw])$/.test(vv) && !vv.includes('%'))
          report.unmappable.push({ class: hit.cls, property: hit.prop, value: hit.value, from: src })
        continue
      }
      if (r.gtc && !r.gtc.path.startsWith('global.')) {   // CSS already routes through a component token
        report.bindings.push({ element: el, property: hit.prop, token: a, from: src })
        continue
      }
      if (sample.rawSize && !sample.size) {   // off-scale size key (icon …) — bind, don't pollute medium
        report.bindings.push({ element: el, property: hit.prop, token: a, sizeKey: sample.rawSize, from: src })
        continue
      }
      const sizeMode = sample.size || 'medium'
      put(`component.${el}.${dimId}`, 'dimension', sizeMode, a, src)
      continue
    }

    if (GLOBAL_BIND.has(hit.prop)) {
      const b = { element: el, property: hit.prop, state: hit.state, from: src }
      if (r.gtc) b.token = `{${r.gtc.path}}`
      else if (hit.prop === 'font-weight') {
        const n = parseInt(r.value ?? hit.value, 10)
        if (!isNaN(n)) b.token = `{${putGlobal(`global.typography.font-weight.${WEIGHT_ROLE[n] || n}`, 'fontWeight', n, src)}}`
      } else if (hit.prop === 'opacity') {
        const n = parseFloat(r.value ?? hit.value)
        if (!isNaN(n)) b.token = `{${globalOpacity(Math.round((n > 1 ? n / 100 : n) * 100), src)}}`
      } else if (hit.prop === 'font-size' || hit.prop === 'letter-spacing') {
        if (rawPx != null) b.token = `{${globalDim(hit.prop, rawPx, src)}}`
      } else if (hit.prop === 'line-height') {
        if (rawPx != null) b.token = `{${globalDim('line-height', rawPx, src)}}`
        else b.value = r.value ?? hit.value
      } else if (hit.prop === 'z-index') {
        const n = parseInt(r.value ?? hit.value, 10)
        if (!isNaN(n)) b.token = `{${putGlobal(`global.z-index.${n}`, 'number', n, src)}}`
      } else if (hit.prop === 'transition-duration') {
        const v = String(r.value ?? hit.value)
        if (/^[\d.]+m?s$/.test(v)) b.token = `{${putGlobal(`global.motion.duration.${v.replace('.', '-')}`, 'duration', v, src)}}`
      } else b.value = String(r.value ?? hit.value).slice(0, 120)
      report.bindings.push(b)
      continue
    }

    if (!UNMAPPED_OK.has(hit.prop))
      report.unmappable.push({ class: hit.cls, property: hit.prop, value: String(hit.value).slice(0, 120), from: src })
  }

  // dark-only dimensions: skipped above, but if no light counterpart minted the
  // token, the value exists only in code — surface it instead of losing it
  report.darkOnlyDimensions = darkDims.filter(d =>
    !tokens.has(`component.${d.el}.${d.dimId}`) && !tokens.has(`component.${d.el}.${d.dimId}.default`))

  // component tokens with size modes: always three (§4 — mirror medium, say so)
  for (const [p, t] of tokens) {
    if (!p.startsWith('component.')) continue
    const sized = [...t.modes.keys()].some(m => m !== 'medium' && SIZE_MODES.has(m))
    if (!sized) continue
    const med = t.modes.get('medium') ?? t.modes.get('small') ?? [...t.modes.values()][0]
    for (const need of ['small', 'medium', 'large']) {
      if (!t.modes.has(need)) { t.modes.set(need, med); report.filledModes.push({ token: p, mode: need, mirrored: med }) }
    }
  }

  // a token nested under another token is invisible to DTCG walkers — give the
  // parent an explicit `default` Identifier (the repo's own -default convention)
  // ponytail: O(n²) prefix scan; fine at <2k tokens
  {
    report.renamedDefault = []
    const names = [...tokens.keys()]
    for (const p of names) {
      if (names.some(q => q !== p && q.startsWith(p + '.'))) {
        if (!tokens.has(p + '.default')) {
          tokens.set(p + '.default', tokens.get(p))
          report.renamedDefault.push({ from: p, to: p + '.default' })
        } else report.conflicts.push({ token: p, mode: 'rename', kept: p + '.default', dropped: p })
        tokens.delete(p)
      }
    }
  }

  // near-duplicate colors (§6.4 — the drift finding)
  const colors = [...tokens].filter(([p, t]) => p.startsWith('global.color.') && !p.includes('.opacity.') && typeof t.modes.get('light') === 'string' && t.modes.get('light').startsWith('#'))
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const a = colors[i][1].modes.get('light'), b = colors[j][1].modes.get('light')
      if (a.length !== b.length) continue
      let d = 0
      for (let k = 1; k < 7; k += 2) d = Math.max(d, Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)))
      if (d > 0 && d <= 6) report.nearDuplicate.push({ a: colors[i][0], b: colors[j][0], values: `${a} / ${b}`, maxChannelDelta: d })
    }
  }
  // same class hit in light+dark (or repeated states) duplicates report rows — dedupe exact
  const dedupe = arr => { const seen = new Set(); return arr.filter(e => { const k = JSON.stringify(e); return seen.has(k) ? false : (seen.add(k), true) }) }
  report.unmappable = dedupe(report.unmappable)
  report.rawLiteral = dedupe(report.rawLiteral)
  report.unreachable = dedupe(report.unreachable)
  report.conflicts = dedupe(report.conflicts)
  // offScale repeats per source — one row per token+value, count kept, first source wins
  {
    const seen = new Map()
    report.offScale = report.offScale.filter(o => {
      const k = o.token + '|' + o.value
      if (seen.has(k)) { seen.get(k).count++; return false }
      o.count = 1; seen.set(k, o); return true
    })
  }
  return { tokens, report }
}
function bridgeCovers(r, compiled) {
  const n = r.varName || (r.colorMix && r.colorMix.inner.varName)
  return n ? SHADCN_BRIDGE[n] != null : false
}
function bridgeTokenFor(r) {
  const n = r.varName || (r.colorMix && r.colorMix.inner.varName)
  return n && SHADCN_BRIDGE[n] ? `{${SHADCN_BRIDGE[n]}}` : null
}
function guessProp(p) {
  if (/radius/.test(p)) return 'border-radius'
  if (/font-size/.test(p)) return 'font-size'
  if (/border/.test(p)) return 'border-width'
  return 'size'
}
function aliasType(own, target) {
  const t = target || ''
  if (t.includes('.opacity.')) return 'number'
  if (t.startsWith('global.color')) return 'color'
  if (t.includes('font-weight')) return 'fontWeight'
  if (t.includes('font-family')) return 'fontFamily'
  if (t.includes('duration')) return 'duration'
  if (t.includes('easing')) return 'cubicBezier'
  if (t.includes('shadow')) return 'shadow'
  if (t.includes('z-index')) return 'number'
  if (t.startsWith('global.') || t.startsWith('component.')) return 'dimension'
  if (own.startsWith('component.')) return 'dimension'   // component never carries looks
  if (/surface|\.text(\.|$)|border|icon|ring|fill|brand|danger|chart|outline/.test(own)) return 'color'
  return 'dimension'
}
function typeFor(p, v) {
  if (/\.opacity\./.test(p)) return 'number'
  if (p.includes('color') || (v && cssColorToHex(v))) return 'color'
  if (/font-weight/.test(p)) return 'fontWeight'
  if (/font-family/.test(p)) return 'fontFamily'
  if (/line-height/.test(p)) return typeof v === 'string' && toPx(v) != null ? 'dimension' : 'number'
  if (/duration/.test(p)) return 'duration'
  if (/easing|motion\.ease/.test(p)) return 'cubicBezier'
  if (/shadow/.test(p)) return 'shadow'
  if (/z-index/.test(p)) return 'number'
  if (v != null && toPx(v) != null) return 'dimension'
  return 'dimension'
}
function normalizeGlobal(p, v) {
  if (/\.opacity\./.test(p)) { const n = parseFloat(v); return isNaN(n) ? v : n > 1 ? n / 100 : n }
  const hex = cssColorToHex(v)
  if (hex) return hex
  const key = p.split('.').pop()
  if (/^\d+(\.\d+)?$/.test(key)) {                 // factual scale key — value must mirror it
    const px = toPx(v)
    if (px != null && typeFor(p, v) === 'dimension') return `${fmtNum(px)}px`
  }
  if (/font-weight/.test(p)) { const n = parseInt(v, 10); if (!isNaN(n)) return n }
  if (/line-height/.test(p) && /^[\d.]+$/.test(v)) return parseFloat(v)
  const px = toPx(v)
  if (px != null && !/line-height/.test(p)) return `${fmtNum(px)}px`
  return v
}

// =========================================================================
// Emit — DTCG tree, one file per scale/component, full name-path kept
// =========================================================================
function emit(tokens, report) {
  const files = new Map()   // relPath -> nested object
  const defaultOf = t => t.modes.get('light') ?? t.modes.get('medium') ?? [...t.modes.values()][0]
  for (const [p, t] of tokens) {
    const parts = p.split('.')
    const [group, scale] = parts
    if (!scale) continue
    const rel = `${group}/${scale}/${scale}.json`
    if (!files.has(rel)) files.set(rel, {})
    let node = files.get(rel)
    for (const seg of parts.slice(0, -1)) node = node[seg] ??= {}
    const leaf = parts[parts.length - 1]
    const entry = { $type: t.type, $value: defaultOf(t) }
    const modeKeys = [...t.modes.keys()]
    if (modeKeys.length > 1 || (modeKeys.length === 1 && modeKeys[0] !== 'light' && modeKeys[0] !== 'medium')) {
      entry.$extensions = { mode: Object.fromEntries([...t.modes]) }
    }
    if (node[leaf] && node[leaf].$value !== undefined) {
      report.conflicts.push({ token: p, mode: 'emit', kept: 'existing node', dropped: 'duplicate path' })
      continue
    }
    node[leaf] = entry
  }
  fs.rmSync(OUT, { recursive: true, force: true })
  for (const [rel, obj] of files) {
    const f = path.join(OUT, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n')
  }
  fs.writeFileSync(path.join(OUT, '_import-report.json'), JSON.stringify(report, null, 2) + '\n')
  return files.size
}

// =========================================================================
// main
// =========================================================================
const inventory = scanClasses()
const candidates = [...inventory.classes.keys()]
if (!candidates.length) die('class scan found zero classes — is this the right repo?')
const css = await compileCss(candidates)
const compiled = walkCss(css, new Set(candidates))
const resolver = makeResolver(compiled.vars)
const { tokens, report } = build(inventory, compiled, resolver)
const nFiles = emit(tokens, report)

const counts = {
  tokens: tokens.size, files: nFiles, classes: inventory.classes.size, cssHits: compiled.hits.length,
  unreachable: report.unreachable.length, offScale: report.offScale.length,
  rawLiteral: report.rawLiteral.length, nearDuplicate: report.nearDuplicate.length,
  unnamedRole: report.unnamedRole.length, unmappable: report.unmappable.length,
  bindings: report.bindings.length, conflicts: report.conflicts.length,
  compoundVariants: report.compoundVariants.length, shadcn: SHADCN,
}
if (JSON_ONLY) console.log(JSON.stringify(counts))
else {
  console.log(`emitted ${tokens.size} tokens into ${nFiles} files under ${OUT}`)
  console.log(`shadcn detected: ${SHADCN}`)
  console.log('loss report: ' + path.join(OUT, '_import-report.json'))
  for (const k of ['unreachable', 'offScale', 'rawLiteral', 'nearDuplicate', 'unnamedRole', 'unmappable'])
    console.log(`  ${k}: ${counts[k]}`)
  console.log(`  bindings: ${counts.bindings}, conflicts: ${counts.conflicts}, compoundVariants: ${counts.compoundVariants}`)
}
