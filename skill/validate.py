#!/usr/bin/env python3
"""Deep-merge every *.json under global/ theme/ component/, then resolve every alias.
Fails on a dangling ref, a global token that aliases anything (global is the source of
truth and never points out), a theme/component token that stores a raw value (they only
alias), or a reference cycle (a token must never resolve back to itself, directly or
through a chain). Run: python3 validate.py [token-root] (defaults to the script's folder)"""
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

def walk(node, path, tokens, raws):
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
        return
    if isinstance(node, dict):
        for k, v in node.items():
            if k.startswith("$"): continue
            walk(v, path + [k], tokens, raws)

def main():
    data = load()
    tokens, raws = {}, {}
    for k, v in data.items():
        walk(v, [k], tokens, raws)

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

    if errors:
        print("\n".join(errors)); sys.exit(1)
    print(f"OK: {len(tokens)} tokens, all aliases resolve, global holds no aliases, theme/component hold no raw values, no cycles.")

if __name__ == "__main__":
    main()
