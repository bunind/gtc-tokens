---
name: gtc-tokens
description: Audit, create, sync, or bootstrap GTC (Global/Theme/Component) design tokens. Use when the user types /gtc-tokens (with :audit, :create, :new, or :sync), asks to review design tokens, mentions the GTC model or token taxonomy, or wants a new token set from the GTC starter template.
---

# GTC Tokens

Operate design token sets built on the GTC model. The rulebook is `reference.md` in this skill folder — **read it before doing anything**. The canonical spec is https://buninux.com/design-tokens; consult it only if reference.md is ambiguous.

## Startup (every invocation)

1. Read `reference.md`.
2. Locate the **token root**: a folder containing `global/` + `theme/` + `component/`, or a single `tokens.json` / `*.tokens.json`. Search the cwd, then ask the user if nothing is found. `:new` skips this — it creates the root.
3. Route on the command word. Accept it in any form the user types — normalize by lowercasing and stripping a leading `:` or `/gtc-tokens` prefix, then match the bare word `audit` / `create` / `new` / `sync`. All of these route to `:sync`: `/gtc-tokens:sync`, `/gtc-tokens :sync`, `/gtc-tokens sync`, and a bare arg of `sync` or `:sync`. No command word, or an unrecognized one → show the menu.

**Output convention:** every data set shown to the user — audit findings, sync diffs, mapping proposals, created-token lists, bootstrap trees — is rendered as vertical records, never wide multi-column tables (they wrap unreadably in narrow terminals). One record per token/finding, one `label: value` line per field. Separate each record from the next with a short fixed divider `--------` (exactly 8 dashes, never full-width, so it never wraps to a new line). Fence as ` ```yaml ` so the field labels (`token:`, `value:`, `modes:`) get the highlighter's key color, and keep the `{}` braces on alias values so they read as real token references. **Indent the divider by two spaces to match the field lines** — at column 0 a `---`-run reads as a YAML document separator and gets colored; indented, it is a plain scalar and renders in the default terminal text color:

```yaml
  token: theme.card.border
  value: {global.color.base.2}
  modes: light {global.color.base.2} / dark {global.color.base.8}
  --------
  token: component.card.radius
  value: {global.radius.8}
  modes: small {global.radius.4} / medium {global.radius.8} / large {global.radius.12}
  --------
```

Short two-column summaries (check → result) may stay tabular. Prose is for verdicts and questions only.

## Menu (bare `/gtc-tokens`)

Present via AskUserQuestion — one question, "GTC Tokens — what do you want to do? (Other → ask a question about the GTC model/skill)", four options. A free-text "Other" answer is treated as a question about the GTC model or this skill: answer it from reference.md, then re-offer the menu.

| Option (label → routes to) | Description |
|----------------------------|-------------|
| `Audit` → `:audit` | Review the token set against the GTC model |
| `Create` → `:create` | Add tokens or a components |
| `Sync` → `:sync` | Sync tokens with another .json file |
| `New from template` → `:new` | Start new GTC project from template |

Order by context: token root found → `:audit` first, then `:create`; no token root → `:new` first (and recommend it). Run the chosen command's procedure.

## :audit — read-only review

1. Mechanical pass: `python3 <skill-dir>/validate.py <token-root>` — dangling refs, global-aliases-out, raw values in theme/component, cycles, color tokens in component, non-factual scale keys, mixed theme/size modes, `$value` not mirroring the default mode. It also *warns* when a mode-carrying token's own path contains one of its mode names — judge each warning (fine if the word names the token's look, a finding if it names the switching context) and report the verdict.
2. Rule pass — check every token against reference.md rules the validator can't see. Report each under its short rule name (use these exact labels in the output):
   - `name order` — starts with a Group; level order `Group → Element → Classifier → Identifier → State`.
   - `separators` — dots separate levels, hyphens only join words inside one level (`size-unit` ✓, `surface-page` ✗).
   - `classifier use` — only after Group/Element; on variant-specific appearance tokens; absent on structural tokens and single-variant components.
   - `mode name in path` — a mode as switching context never appears in a token name, even when the token doesn't carry that mode itself (the validator only warns about a token's own modes).
   - `theme routing` — structural values alias Global directly, and route through Theme only when they switch on a theme mode.
   - `role-based names` — design role, never screen/feature (`sidebar-text`, `login-spacing` → flag).
3. Report findings ranked: breaks resolution → breaks the model → breaks the taxonomy → style. Each finding: token, file, rule, suggested fix. Count issues as `issues`; a rule's scope over mode-carrying tokens is `mode tokens`. **Do not edit** — offer to fix on request.

## :create — add tokens / components

**Input (obligatory, two steps — never skip, never assume from cwd):**

- Step 1 — ask for the folder path: "Enter the path to the token set folder." Show the tip: `Tip: folder path, e.g. ~/Projects/my-app/tokens`. Wait for the path; verify it exists and contains token JSON (`global/`+`theme/`+`component/`, or `*.tokens.json` / `tokens.json`); if not, say what's missing and re-ask.
- Step 2 — ask the intent: "What do you want to do?" (e.g. `add a card component`, `add a danger button variant`, `add a size-unit step`).

`:create` covers add, delete, and move/rename of tokens and components — all three are edits under this command.

1. Parse intent from step 2: new primitive, theme look, variant, or component — or delete / move an existing one.
2. Pick the group by *what the value varies by* (reference.md "Where does it go?"): fixed raw → global; theme mode or semantic look → theme; size or per-component structure → component.
3. Follow the reference.md recipes (Working the tokens): new component = copy the `component/button/` shape, rename the key, repoint structural aliases per size mode, add `theme/<name>/` only if it needs its own look; variant = theme token aliasing a hue ramp; primitive = extend the factual scale (key = value).
4. Name by the taxonomy: minimum levels; Classifier only if multi-variant; State last.
5. Never write a raw value in theme/component — if no fitting global primitive exists, add the primitive first and say so.
6. Finish: run the validator, then show the unified success confirmation — same shape for every `:create` action (created, deleted, moved), no emoji. One line stating the action and count, then a yaml record per affected token:

```yaml
  created: card (6 tokens)
  --------
  token: component.card.radius
  value: {global.radius.8}
  modes: small / medium / large
  --------
```

Use the matching verb per action — `created` / `deleted` / `moved` — and for a move show `from:` and `to:` paths. If the validator fails, show its error instead of the success message.

## :new — bootstrap a project

1. Ask the user for the target folder; create it if missing.
2. If it already contains `global/`, `theme/`, or `component/` — stop and report. Never overwrite an existing token set.
3. Copy `<skill-dir>/template/` contents into it, plus `<skill-dir>/validate.py` and `<skill-dir>/reference.md` (rename to `README.md`).
4. Run `python3 validate.py` in the new root; report the token count and tree.

## :sync — reconcile two token sources

A = the source (incoming tokens — another `.json`, or a `/tokens-sync` DTCG export); B = the set to sync/diff against, and the one written to (token root). Direction is always A → B unless the user says otherwise.

**Path input (obligatory, two steps — never skip, never assume from cwd):**

- Step 1 — ask for folder A (source): "Enter the path to the source folder holding the incoming tokens (.json) (A)." Show the tip: `Tip: folder path, e.g. ~/Projects/my-app/tokens`
- Step 2 — ask for folder B (set to sync against): "Enter the path to the folder holding the token set to sync/diff against (B)." Same tip format.
- Each step: wait for the user's path, verify it exists and contains token JSON (`global/`+`theme/`+`component/`, or `*.tokens.json` / `tokens.json`); if not, say what's missing and re-ask. Known candidates on disk may be listed as a convenience, but the user types the path.

1. Load both; flatten to `name → {$type, $value, modes}` (deep-merge folder trees the way validate.py does). Detect B's shape rather than assuming — a /tokens-sync export is a DTCG tree and may or may not carry `$extensions.mode`.
2. Diff: added / removed / value-changed / mode-changed / type-changed. If there are zero deltas — whether A and B are the same path, or two different paths whose flattened tokens are identical — stop here and show the unified message `Token files are identical! Congrats` (nothing to sync, no confirmation, no validator run).
3. Map incoming names that don't fit GTC into the taxonomy (Figma collection paths → `global.color.*` etc.); list unmappable names instead of guessing. **Match on `$type` + design role, never on raw value alone** — equal values across types (`font-size 12` vs `radius.12`, `letter-spacing 0` vs `opacity.0`) are coincidences, not mappings.
4. Present the diff grouped by change type; wait for confirmation. Never silently delete tokens that exist only in B — list them and let the user decide.
5. Apply confirmed changes to B, preserving B's file layout (one file per folder stays one file per folder).
6. Finish: run the validator; report applied / skipped counts.
