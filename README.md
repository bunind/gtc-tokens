# GTC Design Tokens

Skill and template for the **[GTC tokens model](https://buninux.com/design-tokens)**. GTC is a design token framework that helps product teams and AI manage and scale tokens in large-scale UI systems. The model is built around three principles:

- **Naming**: how to name tokens so they stay clear as the system grows.
- **Composition**: how to group tokens so they're easy to manage and extend.
- **Scope**: how far a change travels, so a value updates globally, per theme, or per component, and never further than it needs to.

You can teach AI to use the model by installing the `/gtc-tokens` skill.

## Using as a Claude Code skill

If you use [Claude Code](https://claude.com/claude-code), clone this repo and copy the skill into your skills folder:

```bash
git clone https://github.com/bunind/gtc-tokens.git
cp -r gtc-tokens/skill ~/.claude/skills/gtc-tokens
```

Then in any Claude Code session, run `/gtc-tokens`. The skill lets you audit a token set against the GTC model, create tokens and components, sync with another `.json` file, import tokens out of a Tailwind codebase, or start a new project from the bundled template.

If you plan to edit the skill, symlink it instead of copying — a copy drifts from the repo:

```bash
ln -s "$PWD/gtc-tokens/skill" ~/.claude/skills/gtc-tokens
```

## Importing from code

`:import` extracts a GTC token set out of an existing **Tailwind v4** repo (shadcn included). It reads the component sources for their class inventory, compiles Tailwind against those classes, routes results into `global/`, `theme/` and `component/`, and emits a DTCG tree plus a report naming issues, unreachable classes, off-scale values, raw literals, or near-duplicates. `:import` hands the tree to `:sync`, which owns the diff and the write.

Tailwind v3 is not supported: a repo without `@theme` is told to upgrade first. The extractor installs nothing — `typescript`, `postcss` and `@tailwindcss/node` are resolved out of the repo being imported. One exception: the class scan needs TypeScript's classic compiler API, which the TypeScript 7 native port dropped, so a TS 7 repo is imported with `--ts <dir holding typescript@6>` and keeps its own dependencies untouched.

## What's here

- **`skill/`**: the `/gtc-tokens` Claude Code skill. Copy it into `~/.claude/skills/gtc-tokens/` to use. It bundles its own copy of the template so `:new` works standalone, and that copy stays identical to `template/`.

- **`skill/import/`**: the `:import` extractor — `import.mjs` (no dependencies of its own) and `check.mjs`, which runs it against a shadcn button fixture and asserts the routing still holds.

- **`template/`**: the starter token set: `global/`, `theme/`, and `component/`, one JSON file per scale or component. Run `python3 validate.py` to check it against the GTC model.

- **`README.md`**: the GTC rulebook, written for AI agents. It covers the model, taxonomy, modes, and scale keys. AI reads it before adding or editing a token.

- **`.github/workflows/check.yml`**: CI for maintainers. On every push it confirms the skill's bundled copy of the template hasn't drifted from `template/`, that both token sets still pass `validate.py`, and that the `:import` extractor still produces a valid tree from its fixture.

## Skill commands

- `:audit` — review the token set against the GTC model.
- `:create` — add tokens or a component.
- `:sync` — sync tokens with another `.json` file.
- `:import` — extract tokens from a Tailwind v4 codebase.
- `:new` — start a new GTC project from the template.

## License

[MIT LICENSE](LICENSE)
