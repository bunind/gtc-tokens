#!/usr/bin/env python3
"""Self-check for gtc.py on a throwaway copy of the template. Run: python3 skill/check_gtc.py"""
import pathlib, shutil, subprocess, sys, tempfile

SKILL = pathlib.Path(__file__).resolve().parent
proj = pathlib.Path(tempfile.mkdtemp())
root = proj / "tokens"
shutil.copytree(SKILL / "template", root)
for f in ("gtc.py", "validate.py"):
    shutil.copy(SKILL / f, root)

def run(*a):
    r = subprocess.run([sys.executable, str(root / "gtc.py"), *a], capture_output=True, text=True)
    return r.returncode, r.stdout

assert run("init")[0] == 0 and run("init")[0] == 0
assert (proj / "CLAUDE.md").read_text().count("<!-- gtc-tokens -->") == 1, "init must not duplicate the pointer block"
assert (root / "TOKENS.md").read_text().count("\n") < 160

text = root / "theme/text/text.json"
before = text.read_text()
assert run("set", "theme.text.secondary", "#123456")[0] == 1 and text.read_text() == before, "raw value in theme must be refused"
assert run("set", "theme.text.secondary", "{global.color.nope.1}")[0] == 1 and text.read_text() == before, "invalid write must be undone"
code, out = run("set", "theme.text.secondary@ocean-dark", "{global.color.blue.4}")
assert code == 1 and "global.color.brand.3@ocean" in out, "a brand mode on theme must be refused, pointing at global"
assert run("set", "global.color.brand.3@dark", "#000000")[0] == 1, "a theme mode on global must be refused"

# brand = a mode of a global token; a theme token follows through its alias, per theme mode
color = root / "global/color/color.json"
before = color.read_text()
code, out = run("set", "global.color.brand.3@ocean", "#0e7490")
assert code == 0 and "#0e7490" in out, out
sys.path.insert(0, str(root)); sys.dont_write_bytecode = True; import gtc
idx = gtc.load()[1]
base = idx["global.color.brand.3"][1]["$value"]
assert base != "#0e7490" and gtc.modes(idx["global.color.brand.3"][1]) == {"ocean": "#0e7490"}, "default brand stays in $value"
assert f"global.color.brand.3  {base} · ocean #0e7490" in (root / "TOKENS.md").read_text()
user = next(p for p, (_, n) in idx.items() if p.startswith("theme.") and "global.color.brand.3" in gtc.refs(n))
assert gtc.resolve(idx, user, "ocean") == "#0e7490", "theme token must follow the brand through its alias"
assert run("set", "global.size-unit.12@ocean", "13px")[0] == 1, "a brand value on a factual key must be factual"
color.write_text(before); run("map")

code, out = run("set", "theme.text.secondary@dark", "{global.color.base.4}")
assert code == 0 and "#a3a3a3" in out, out
assert "theme.text.secondary  {global.color.base.6} · dark {global.color.base.4}" in (root / "TOKENS.md").read_text()

assert run("set", "component.badge.size", "{global.size-unit.20}", "component.badge.size@small", "{global.size-unit.16}")[0] == 0
assert (root / "component/badge/badge.json").exists() and "component.badge.size" in (root / "TOKENS.md").read_text()
assert run("set", "global.size-unit.33", "33")[0] == 0, "bare number in a dimension group must be accepted"
assert '"33": {"$type": "dimension", "$value": "33px"}' in (root / "global/size-unit/size-unit.json").read_text(), "new token takes its group's $type"
assert run("rm", "global.size-unit.33")[0] == 0
assert run("rm", "global.color.brand.3")[0] == 1, "rm of an aliased token must be refused"
assert run("rm", "component.badge.size")[0] == 0 and not (root / "component/badge/badge.json").exists()

# a hand edit is picked up by the next validate run (the build calls it), so the map never goes stale
(root / "global/color/color.json").write_text((root / "global/color/color.json").read_text().replace("#6158d2", "#7c3aed"))
subprocess.run([sys.executable, str(root / "validate.py")], check=True, capture_output=True)
assert "#7c3aed" in (root / "TOKENS.md").read_text()

shutil.rmtree(proj)
print("OK: gtc.py check passed")
