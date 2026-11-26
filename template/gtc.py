#!/usr/bin/env python3
"""GTC token tool for agents. Lives in the token root next to validate.py.
  init                       write TOKENS.md + the pointer block in the project's CLAUDE.md and AGENTS.md
  map                        rewrite TOKENS.md (validate.py also does this when TOKENS.md exists)
  get <path>                 file, type, modes, resolved value, what aliases it, where CSS uses it
  set <path[@mode]> <value> [<path[@mode]> <value> ...] [--type T] [--no-build]
                             change or create tokens, then validate, rewrite TOKENS.md, npm run build - one call
                             a brand is a mode of a global token: set global.color.brand.3@ocean '#0e7490'
  rm <path>                  delete a token; refused while a token or CSS still uses it
  sweep                      delete inline style overrides on components that pin a token's old value
                             (left by `set`, or by a CSS edit since TOKENS.md was written); nothing else
Exit: 0 ok, 1 refused or invalid (files untouched), 2 build failed (tokens written)."""
import json, re, sys, pathlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parent
PROJECT = ROOT.parent
REL = ROOT.name
REF = re.compile(r"^\{([^}]+)\}$")
# same sets as validate.py. Any other mode name is a brand, and lives on global tokens only: theme and
# component tokens follow through their aliases, so brand x theme x size never multiplies.
# ponytail: resolve() takes one mode, so `get` shows a theme token per theme, not per brand x theme
BRAND = re.compile(r"^[a-z][a-z0-9-]*$")
THEME_MODES = {"light", "dark", "high-contrast"}
SIZE_MODES = {"2xsmall", "xsmall", "small", "medium", "large", "xlarge", "2xlarge"}
BLOCK = f"""<!-- gtc-tokens -->
Design tokens (GTC) live in {REL}/. Read {REL}/TOKENS.md first: which token each CSS selector uses, then every token and value.
Change tokens only with `python3 {REL}/gtc.py set <path>[@mode] <value> ...` (validates, rebuilds, one call). Never hand-edit {REL}/**/*.json, validate.py or gtc.py.
After any restyle (set or a CSS edit), run `python3 {REL}/gtc.py sweep`: it deletes inline style="" overrides that still hold the old value.
<!-- /gtc-tokens -->"""


def leaves(node, path=()):
    if isinstance(node, dict) and "$value" in node:
        yield path, node
    elif isinstance(node, dict):
        for k, v in node.items():
            if not k.startswith("$"):
                yield from leaves(v, path + (k,))


def load():
    trees = {f: json.loads(f.read_text()) for f in sorted(ROOT.glob("*/**/*.json"))}
    idx = {}
    for f in sorted(trees, key=lambda f: ("global", "theme", "component").index(f.relative_to(ROOT).parts[0])
                    if f.relative_to(ROOT).parts[0] in ("global", "theme", "component") else 9):
        for p, n in leaves(trees[f]):
            idx[".".join(p)] = (f, n)
    return trees, idx


def modes(n):
    return n.get("$extensions", {}).get("mode", {})


def refs(n):
    return [m[1] for v in [n["$value"], *modes(n).values()] if isinstance(v, str) and (m := REF.match(v))]


def resolve(idx, path, mode=None, depth=0):
    n = idx[path][1]
    v = modes(n).get(mode, n["$value"])
    m = REF.match(v) if isinstance(v, str) else None
    if m and m[1] in idx and depth < 50:
        return resolve(idx, m[1], mode, depth + 1)
    return v


def fmt(v):
    return json.dumps(v, ensure_ascii=False, separators=(", ", ": ")) if not isinstance(v, str) else v


def dump(n, ind=0):
    # one token per line: greppable, and a one-token edit is a one-line diff
    if not isinstance(n, dict) or "$value" in n:
        return json.dumps(n, ensure_ascii=False, separators=(", ", ": "))
    pad = "  " * (ind + 1)
    return "{\n" + ",\n".join(f"{pad}{json.dumps(k)}: {dump(v, ind + 1)}" for k, v in n.items()) + "\n" + "  " * ind + "}"


def css_rules(idx):
    # -> [(selector, [(prop, value with token paths)])]
    # ponytail: plain CSS only, naive rule regex (innermost braces); add .scss/.tsx scanning when a project needs it
    names = {"--" + p.replace(".", "-"): p for p in idx}
    out = []
    for f in sorted(PROJECT.rglob("*.css")):
        if "node_modules" in f.parts or ROOT in f.parents:
            continue
        text = re.sub(r"/\*.*?\*/", "", f.read_text(errors="ignore"), flags=re.S)
        for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", text):
            decls = []
            for d in body.split(";"):
                prop, _, val = d.partition(":")
                prop = prop.strip()
                if prop.startswith("--") or "var(--" not in val:
                    continue  # custom-property definitions (e.g. generated tokens.css) are not usage
                new = re.sub(r"var\((--[\w-]+)\)", lambda m: names.get(m[1], m[0]), val.strip())
                if new != val.strip():
                    decls.append((prop, new))
            if decls:
                out.append((" ".join(sel.split()), decls))
    return out


def css_usage(idx):
    return [f"{sel}  " + " · ".join(f"{p}: {v}" for p, v in decls) for sel, decls in css_rules(idx)]


# --- inline overrides: style="" on a component that repeats a token's value, so it pins that value when the token moves
MARKUP = {".html", ".htm", ".vue", ".svelte", ".astro"}  # ponytail: style="..." strings only; add JSX style={{}} parsing when a React project needs it
TAG = re.compile(r"<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+))?)*)\s*(/?)>")
PENDING = ".overrides"


def norm(v):
    v = re.sub(r"\s+", " ", re.sub(r"\s*!important\s*$", "", str(v).strip().lower()))
    return re.sub(r"#([0-9a-f])([0-9a-f])([0-9a-f])\b", lambda m: "#" + "".join(c * 2 for c in m.groups()), v)


def value(expr, idx):
    # declaration value with every token path resolved (default mode); px-only calc() evaluated
    v = re.sub(r"\b[a-z][\w-]*(?:\.[\w-]+)+", lambda m: str(resolve(idx, m[0])) if m[0] in idx else m[0], expr)
    inner = v[5:-1] if v.startswith("calc(") and v.endswith(")") else ""
    if "px" in inner and re.fullmatch(r"[\d.\s+\-*/()]+", inner.replace("px", "")):
        v = f"{eval(inner.replace('px', '')):g}px"  # ponytail: digits and operators only, checked above; rem/% calc stays as text
    return norm(v)


def map_rules():
    # CSS usage as of the last TOKENS.md write: the baseline that shows a CSS edit made since
    f = ROOT / "TOKENS.md"
    text = f.read_text() if f.exists() else ""
    if "## CSS usage" not in text:
        return None
    rules = []
    for line in text.split("## CSS usage", 1)[1].split("\n## ", 1)[0].splitlines()[1:]:
        sel, sep, body = line.partition("  ")
        if sep:
            rules.append((sel, [tuple(x.strip() for x in d.partition(":")[::2]) for d in body.split(" · ")]))
    return rules


def pinned(old_rules, old_idx, new_rules, new_idx):
    # declarations whose value moved: [prop, old value, old parts that changed]. A removed declaration is skipped:
    # its overrides now carry the style, deleting them would change the page.
    new = {(s, p): v for s, ds in new_rules for p, v in ds}
    out = []
    for s, ds in old_rules:
        for p, v in ds:
            if (s, p) not in new:
                continue
            a, b = value(v, old_idx), value(new[(s, p)], new_idx)
            c = [p, a, [x for x in a.split() if x not in b.split()]]
            if a != b and c not in out:
                out.append(c)
    return out


def hit(crit):
    # an override matches the property and the old value, or is a longhand (border-color) of a changed shorthand part
    return lambda p, v: any((p == cp and v == old) or (p.startswith(cp + "-") and v in parts) for cp, old, parts in crit)


def scan(drop=None):
    # every inline declaration on a component in the markup -> [(file, prop, value, dropped)]; drop(prop, value) deletes it.
    # Component = custom element (<ui-button>) or a class a token-using CSS selector names. Others (<i style="height: 36px">) are skipped.
    _, idx = load()
    classes = {c for sel, _ in css_rules(idx) for c in re.findall(r"\.([\w-]+)", sel)}
    out = []
    for f in sorted(PROJECT.rglob("*")):
        if f.suffix not in MARKUP or ROOT in f.parents or {"node_modules", "dist", ".git"} & set(f.parts):
            continue
        text = f.read_text(errors="ignore")

        def tag(m):
            name, attrs, end = m[1], m[2], m[3]
            st = re.search(r"\sstyle=\"([^\"]*)\"", attrs)
            cl = re.search(r"\sclass(?:Name)?=\"([^\"]*)\"", attrs)
            if not st or not ("-" in name or (cl and classes & set(cl[1].split()))):
                return m[0]
            keep = []
            for d in filter(str.strip, st[1].split(";")):
                p, _, v = (x.strip() for x in d.partition(":"))
                gone = bool(drop and drop(p.lower(), norm(v)))
                out.append((f, p.lower(), norm(v), gone))
                gone or keep.append(d.strip())
            attrs = attrs.replace(st[0], f' style="{"; ".join(keep)}"' if keep else "")
            return f"<{name}{attrs}{' ' if end and not attrs.endswith(' ') else ''}{end}>" if end else f"<{name}{attrs}>"

        new = TAG.sub(tag, text)
        if drop and new != text:
            f.write_text(new)
    return out


def pending(new):
    # criteria saved by an earlier set, plus new ones
    f = ROOT / PENDING
    old = json.loads(f.read_text()) if f.exists() else []
    return old + [c for c in new if c not in old]


def cmd_sweep():
    _, idx = load()
    base = map_rules()
    crit = pending(pinned(base, idx, css_rules(idx), idx) if base else [])
    gone = [h for h in scan(hit(crit)) if h[3]] if crit else []
    (ROOT / PENDING).unlink(missing_ok=True)
    write_map()
    props = sorted({f"{p}: {v}" for _, p, v, _ in gone})
    print(f"ok: removed {len(gone)} inline overrides in {len({h[0] for h in gone})} files" + (" (" + ", ".join(props) + ")" if props else ""))


def render(idx):
    lines = [
        f"# Design tokens - generated by {REL}/gtc.py, do not edit. Spec: https://buninux.com/design-tokens",
        "",
        f"Change: `python3 {REL}/gtc.py set <path>[@mode] <value> [<path>[@mode] <value> ...]` - validates, rewrites this file, runs npm run build.",
        f"Also: `gtc.py get <path>` (aliases, usage), `gtc.py rm <path>`. Never hand-edit the JSON, validate.py or gtc.py.",
        f"Example: `python3 {REL}/gtc.py set global.color.brand.4 '#7c3aed' theme.text.link@dark {{global.color.brand.2}}` (one call, many tokens).",
        "Rules: global holds raw values only. theme and component hold aliases only ({global.x}); a new raw value goes in global first.",
        "Colors and anything that differs per theme -> theme.*. Size, radius, font-size of one component, per size mode -> component.*.",
        "CSS variable = -- + path with . -> -  (theme.text.link -> --theme-text-link). New token file: <group>/<2nd segment>/<2nd segment>.json.",
        "Modes: theme light|dark|high-contrast, size small|medium|large; one kind per token. Changing a global value moves every alias of it.",
        "Brand: a mode of global tokens only, any name (global.color.brand.3@ocean '#0e7490'). Theme tokens follow through their alias: never add a brand or 'ocean-dark' mode to theme/component.",
        "",
        "## CSS usage (selector  property: tokens)",
        *css_usage(idx),
        "",
        "## Tokens (path  default · mode value)",
    ]
    groups = {}
    for p, (_, n) in idx.items():
        groups.setdefault(p.rsplit(".", 1)[0], []).append((p.rsplit(".", 1)[1], n))
    done = set()
    for p, (_, n) in idx.items():
        parent = p.rsplit(".", 1)[0]
        kids = groups[parent]
        # a global ramp/scale of plain raw values collapses to one line
        if p.startswith("global.") and len(kids) >= 3 and all(not modes(k) and isinstance(k["$value"], (str, int, float)) for _, k in kids):
            if parent in done:
                continue
            done.add(parent)
            if all(k["$value"] == f"{key}px" for key, k in kids):
                lines.append(f"{parent}  (key = px) " + " ".join(key for key, _ in kids))
            else:
                lines.append(f"{parent}  " + " · ".join(f"{key} {fmt(k['$value'])}" for key, k in kids))
            continue
        default = n["$value"]
        extra = [f"{m} {fmt(v)}" for m, v in modes(n).items() if v != default]
        lines.append(f"{p}  {fmt(default)}" + "".join(f" · {e}" for e in extra))
    return "\n".join(lines) + "\n"


def write_map():
    _, idx = load()
    text = render(idx)
    (ROOT / "TOKENS.md").write_text(text)
    return f"TOKENS.md: {len(idx)} tokens, {text.count(chr(10))} lines"


def init():
    msg = write_map()
    for name in ("CLAUDE.md", "AGENTS.md"):
        f = PROJECT / name
        old = f.read_text() if f.exists() else ""
        pat = re.compile(r"<!-- gtc-tokens -->.*?<!-- /gtc-tokens -->", re.S)
        new = pat.sub(lambda _: BLOCK, old) if pat.search(old) else (old.rstrip() + "\n\n" if old.strip() else "") + BLOCK + "\n"
        f.write_text(new)
    return msg + "; pointer block in CLAUDE.md, AGENTS.md"


def fail(msg, code=1):
    print(msg)
    sys.exit(code)


def parse(s):
    try:
        return json.loads(s)
    except ValueError:
        return s


def guess_type(v, idx):
    m = REF.match(v) if isinstance(v, str) else None
    if m:
        return idx[m[1]][1].get("$type") if m[1] in idx else None
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str) and re.match(r"^(#[0-9a-fA-F]{3,8}|(rgba?|hsla?|oklch)\(.*\))$", v):
        return "color"
    if isinstance(v, str) and re.match(r"^-?\d+(\.\d+)?(px|rem|em)$", v):
        return "dimension"


def cmd_set(args):
    typ = args[args.index("--type") + 1] if "--type" in args else None
    build = "--no-build" not in args
    args = [a for i, a in enumerate(args) if a not in ("--type", "--no-build") and (i == 0 or args[i - 1] != "--type")]
    if not args or len(args) % 2:
        fail("usage: gtc.py set <path>[@mode] <value> [<path>[@mode] <value> ...] [--type T] [--no-build]")
    _, old_idx = load()
    old_rules = map_rules() or css_rules(old_idx)
    trees, idx = load()
    before = {f: f.read_text() for f in trees}
    dirty, done = set(), []
    for key, raw in zip(args[::2], args[1::2]):
        path, _, mode = key.partition("@")
        v = parse(raw)
        glob = path.startswith("global.")
        if mode and glob and (mode in THEME_MODES | SIZE_MODES or not BRAND.match(mode)):
            fail(f"refused: {path}@{mode}: a global token takes brand modes only (lowercase name, e.g. @ocean). "
                 "Theme modes go on theme.*, size modes on component.*.")
        if mode and not glob and mode not in THEME_MODES | SIZE_MODES:
            fail(f"refused: mode '{mode}' unknown on {path}. Theme modes: {' '.join(sorted(THEME_MODES))}; size modes: {' '.join(sorted(SIZE_MODES))}.\n"
                 f"If it is a brand: a brand is a mode of the global tokens, not of theme/component. Give the brand its own values "
                 f"on the global steps this token aliases, per theme mode, e.g.\n"
                 f"  python3 {REL}/gtc.py set global.color.brand.3@{mode.split('-')[0]} '#0e7490'\n"
                 "Light, dark and every size then follow through the aliases.\n"
                 "If it is a new theme mode (not a brand): this tool does not support one yet; stop and report it.\n"
                 "Either way, do not combine modes ('ocean-dark') or edit validate.py or gtc.py.")
        if not path.startswith("global.") and not (isinstance(v, str) and REF.match(v)):
            fail(f"refused: raw value {raw} in {path}. theme/component only alias. Add it to global first, e.g.\n"
                 f"  python3 {REL}/gtc.py set global.color.<ramp>.<step> {raw} {key} {{global.color.<ramp>.<step>}}")
        if path.startswith("global.") and isinstance(v, str) and REF.match(v):
            fail(f"refused: {path} is global; global holds raw values, never aliases")
        if path in idx:
            f, n = idx[path]
        else:
            parent = path.rsplit(".", 1)[0]
            sib = next((n for p, (_, n) in idx.items() if p.rsplit(".", 1)[0] == parent), None)
            t = typ or (sib or {}).get("$type") or guess_type(v, idx)
            if t == "dimension" and isinstance(v, (int, float)):
                v = f"{v}px"  # ponytail: assumes px; a rem group would need the sibling's unit
            if not t:
                fail(f"refused: new token {path}: pass --type (color, dimension, number, fontWeight, ...)")
            group, seg = path.split(".")[:2]
            f = next((g for p, (g, _) in idx.items() if p.split(".")[:2] == [group, seg]), ROOT / group / seg / f"{seg}.json")
            tree = trees.setdefault(f, {})
            node = tree
            for part in path.split(".")[:-1]:
                node = node.setdefault(part, {})
            n = node[path.rsplit(".", 1)[1]] = {"$type": t, "$value": v}
            idx[path] = (f, n)
        ms = modes(n)
        if mode:
            if not ms:
                default = "medium" if mode in SIZE_MODES else "light"
                # a brand mode has no default key: $value is the default brand
                ms = n.setdefault("$extensions", {}).setdefault("mode", {} if glob else {default: n["$value"]})
            ms[mode] = v
            if mode in ("light", "medium"):
                n["$value"] = v
        else:
            n["$value"] = v
            for d in ("light", "medium"):
                if d in ms:
                    ms[d] = v
        dirty.add(f)
        done.append(key)
    for f in dirty:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(dump(trees[f]) + "\n")
    r = subprocess.run([sys.executable, str(ROOT / "validate.py"), str(ROOT)], capture_output=True, text=True)
    if r.returncode:
        for f in dirty:  # put every touched file back exactly as it was
            f.write_text(before[f]) if f in before else f.unlink()
        fail("invalid, nothing written:\n" + r.stdout.strip())
    write_map()
    _, idx = load()
    crit = pending(pinned(old_rules, old_idx, css_rules(idx), idx))
    rows = [r for r in scan() if hit(crit)(r[1], r[2])] if crit else []
    if rows:
        (ROOT / PENDING).write_text(json.dumps(crit))
        what = sorted({f"{p}: {v}" for _, p, v, _ in rows})
        note = (f"\n{len(rows)} inline overrides in {len({r[0] for r in rows})} files pin the old value ({', '.join(what[:6])}"
                f"{', ...' if len(what) > 6 else ''}). Run: python3 {REL}/gtc.py sweep")
    else:
        note = ""
    out = " · ".join(f"{k} = {fmt(resolve(idx, k.partition('@')[0], k.partition('@')[2] or None))}" for k in done)
    pkg = PROJECT / "package.json"
    if build and pkg.exists() and "build" in json.loads(pkg.read_text()).get("scripts", {}):
        b = subprocess.run(["npm", "run", "build", "--silent"], cwd=PROJECT, capture_output=True, text=True)
        if b.returncode:
            fail(f"tokens written ({out}), build FAILED:\n" + "\n".join((b.stdout + b.stderr).strip().splitlines()[-15:]) + note, 2)
        out += " · built"
    print("ok: " + out + note)


def users(idx, path):
    return [p for p, (_, n) in idx.items() if path in refs(n)], [u for u in css_usage(idx) if re.search(rf"\b{re.escape(path)}\b(?![.\w-])", u)]


def cmd_get(path):
    _, idx = load()
    if path not in idx:
        hits = [p for p in idx if path in p]
        fail(f"no token {path}" + (". Close: " + ", ".join(hits[:15]) if hits else ""))
    f, n = idx[path]
    toks, css = users(idx, path)
    print(f"{path}  ({n.get('$type')}, {f.relative_to(PROJECT)})")
    for m, v in ({"default": n["$value"]} | modes(n)).items():
        print(f"  {m}: {fmt(v)} -> {fmt(resolve(idx, path, None if m == 'default' else m))}")
    print("  aliased by: " + (", ".join(toks) or "-"))
    print("  css: " + (" | ".join(css) or "-"))


def cmd_rm(path):
    trees, idx = load()
    if path not in idx:
        fail(f"no token {path}")
    toks, css = users(idx, path)
    if toks or css:
        fail(f"refused: {path} still used by " + ", ".join(toks + css))
    f = idx[path][0]
    node, parts = trees[f], path.split(".")
    chain = []
    for part in parts[:-1]:
        chain.append(node)
        node = node[part]
    del node[parts[-1]]
    for parent, part in zip(reversed(chain), reversed(parts[:-1])):  # prune emptied groups
        if parent[part]:
            break
        del parent[part]
    f.write_text(dump(trees[f]) + "\n") if trees[f] else f.unlink()
    print("ok: removed " + path + " · " + write_map())


def selftest():
    # set path (alias moved via global, calc height, shorthand border) and CSS-edit path (padding rewired); decoys stay
    import tempfile
    global ROOT, PROJECT
    with tempfile.TemporaryDirectory() as d:
        PROJECT = pathlib.Path(d)
        ROOT = PROJECT / "tokens"
        tok = lambda t: (ROOT / "global/x/x.json").parent.mkdir(parents=True, exist_ok=True) or (ROOT / "global/x/x.json").write_text(json.dumps(t))
        g = {"a": "#8e90f5", "b": "#d4d4d4", "s24": "24px", "s32": "32px", "s6": "6px", "b1": "1px"}
        tok({"global": {"x": {k: {"$value": v} for k, v in g.items()}}})
        (ROOT / "theme/y").mkdir(parents=True)
        (ROOT / "theme/y/y.json").write_text('{"theme": {"y": {"brand": {"$value": "{global.x.a}"}}}}')
        css = (".btn { background: var(--theme-y-brand); height: calc(var(--global-x-s24) + 2 * var(--global-x-s6)); "
               "border: var(--global-x-b1) solid var(--global-x-b); }\n.card { padding: var(--global-x-s24); }\n"
               ".chart i { height: 36px; background: #8e90f5; }\n")
        (PROJECT / "page.css").write_text(css)
        page = ('<ui-button style="background: #8E90F5">a</ui-button>\n<ui-button style="background: #000">b</ui-button>\n'
                '<ui-button style="height: 36px; border-color: #d4d4d4; gap: 2px">c</ui-button>\n<i style="height: 36px"></i>\n'
                '<div class="btn" style="background:#8e90f5"></div>\n<ui-card style="padding: 24px"></ui-card>\n')
        (PROJECT / "p.html").write_text(page)
        write_map()
        _, old = load()
        tok({"global": {"x": {k: {"$value": v} for k, v in (g | {"a": "#7c3aed", "b": "#a8a29e", "s24": "33px"}).items()}}})
        _, new = load()
        crit = pinned(map_rules(), old, css_rules(new), new)
        assert ["background", "#8e90f5", ["#8e90f5"]] in crit and ["height", "36px", ["36px"]] in crit, crit
        assert ["border", "1px solid #d4d4d4", ["#d4d4d4"]] in crit, crit
        scan(hit(crit))
        (PROJECT / "page.css").write_text(css.replace("padding: var(--global-x-s24)", "padding: var(--global-x-s32)"))
        tok({"global": {"x": {k: {"$value": v} for k, v in g.items()}}})  # tokens back: only the CSS edit differs from TOKENS.md
        _, idx = load()
        crit = pinned(map_rules(), idx, css_rules(idx), idx)
        assert crit == [["padding", "24px", ["24px"]]], crit
        scan(hit(crit))
        got = (PROJECT / "p.html").read_text()
        want = ('<ui-button>a</ui-button>\n<ui-button style="background: #000">b</ui-button>\n'
                '<ui-button style="gap: 2px">c</ui-button>\n<i style="height: 36px"></i>\n'
                '<div class="btn"></div>\n<ui-card></ui-card>\n')
        assert got == want, got
        assert (PROJECT / "page.css").read_text().count("#8e90f5") == 1  # CSS never touched by sweep
    print("ok: selftest")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["set"]:
        cmd_set(a[1:])
    elif a[:1] == ["get"] and len(a) == 2:
        cmd_get(a[1])
    elif a[:1] == ["rm"] and len(a) == 2:
        cmd_rm(a[1])
    elif a[:1] == ["sweep"]:
        cmd_sweep()
    elif a[:1] == ["selftest"]:
        selftest()
    elif a[:1] == ["map"]:
        print(write_map())
    elif a[:1] == ["init"]:
        print(init())
    else:
        fail(__doc__)
