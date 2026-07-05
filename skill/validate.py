#!/usr/bin/env python3
"""Deep-merge every *.json under global/ theme/ component/, then resolve every alias.
Fails on a dangling ref, a global token that aliases anything (global is the source of
truth and never points out), a theme/component token that stores a raw value (they only
alias), a reference cycle (a token must never resolve back to itself, directly or
through a chain), a color token under component (looks live in theme), a non-factual
scale key (global.size-unit.12 must be "12px"), theme and size modes mixed in one token,
or a $value that doesn't mirror the default mode (light / medium). Warns (exit 0) when a
mode-carrying token's own path contains one of its mode names — legit only if the word
names the token's look, not a switching context.
Run: python3 validate.py [token-root] (defaults to the script's folder)"""
import json, re, sys, pathlib

HERE = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).parent
REF = re.compile(r"^\{([^}]+)\}$")

def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v

def load():
    merged = {}
    for f in sorted(HERE.glob("*/**/*.json")):
        deep_merge(merged, json.loads(f.read_text()))
    return merged

def walk(node, path, tokens, raws, nodes):
    if isinstance(node, dict) and "$value" in node:
        refs = []
        def grab(v):
            m = REF.match(v) if isinstance(v, str) else None
            if m:
                refs.append(m.group(1))
            else:
                raws.setdefault(".".join(path), []).append(v)
        grab(node["$value"])
        for mv in node.get("$extensions", {}).get("mode", {}).values():
            grab(mv)
        tokens[".".join(path)] = refs
        nodes[".".join(path)] = node
        return
    if isinstance(node, dict):
        for k, v in node.items():
            if k.startswith("$"): continue
            walk(v, path + [k], tokens, raws, nodes)

THEME_MODES = {"light", "dark", "high-contrast"}
SIZE_MODES = {"2xsmall", "xsmall", "small", "medium", "large", "xlarge", "2xlarge"}

def main():
    data = load()
    tokens, raws, nodes = {}, {}, {}
    for k, v in data.items():
        walk(v, [k], tokens, raws, nodes)

    errors = []
    for name, refs in tokens.items():
        for r in refs:
            if r not in tokens:
                errors.append(f"dangling ref: {name} -> {{{r}}}")
            elif name.startswith("global."):
                errors.append(f"global aliases out (forbidden): {name} -> {{{r}}}")
    # ponytail: raws also holds global $values (raw by design); filter them out here rather than branch in walk()
    for name, vals in raws.items():
        if not name.startswith("global."):
            for v in vals:
                errors.append(f"raw value in theme/component (forbidden): {name} = {json.dumps(v)}")

    # GTC model rules the merged tree can answer mechanically
    warnings = []
    for name, node in nodes.items():
        modes = node.get("$extensions", {}).get("mode", {})
        key = name.rsplit(".", 1)[-1]
        if name.startswith("component.") and node.get("$type") == "color":
            errors.append(f"color token in component (looks live in theme): {name}")
        # effects keys (shadow.1…3, blur.1…3) are elevation roles, not factual px
        if name.startswith("global.") and key.isdigit() and not name.startswith("global.effects."):
            if node.get("$type") == "dimension" and node["$value"] != f"{key}px":
                errors.append(f'scale key not factual: {name} = {json.dumps(node["$value"])} (expected "{key}px")')
            if ".opacity." in name and node.get("$type") == "number" and node["$value"] != int(key) / 100:
                errors.append(f'scale key not factual: {name} = {node["$value"]} (expected {int(key) / 100})')
        if modes:
            if modes.keys() & THEME_MODES and modes.keys() & SIZE_MODES:
                errors.append(f"theme and size modes mixed in one token: {name} [{', '.join(modes)}]")
            default = modes.get("light", modes.get("medium"))
            if default is not None and node["$value"] != default:
                errors.append(f"$value does not mirror the default mode: {name} = {json.dumps(node['$value'])} vs {json.dumps(default)}")
            clash = set(name.split(".")) & modes.keys()
            if clash:
                warnings.append(f"mode name in token path: {name} carries mode(s) {sorted(clash)} — fine only if the word names the token's look, not a context")

    # cycle check: a token must never resolve back to itself (DFS over resolvable refs)
    WHITE, GREY, BLACK = 0, 1, 2
    state = {n: WHITE for n in tokens}
    def visit(n, stack):
        state[n] = GREY
        for r in tokens.get(n, []):
            if r not in tokens:
                continue
            if state[r] == GREY:
                errors.append("cycle: " + " -> ".join(stack[stack.index(r):] + [r]))
            elif state[r] == WHITE:
                visit(r, stack + [r])
        state[n] = BLACK
    for n in tokens:
        if state[n] == WHITE:
            visit(n, [n])

    if warnings:
        print("\n".join("warning: " + w for w in warnings))
    if errors:
        print("\n".join(errors)); sys.exit(1)
    print(f"OK: {len(tokens)} tokens — aliases resolve, alias direction holds, no raw values in theme/component, "
          f"no cycles, no component colors, scale keys factual, one mode type per token, $value mirrors default mode.")

if __name__ == "__main__":
    main()
