# GTC design tokens

Skill and template for the **[GTC tokens model](https://buninux.com/design-tokens)**. GTC is a design token framework that helps product teams and AI manage and scale tokens in large-scale UI systems. You can teach AI to operate the model by installing the `/gtc-tokens` skill.

## Using as a Claude Code skill

If you use [Claude Code](https://claude.com/claude-code), clone this repo and copy the skill into your skills folder:

```bash
git clone https://github.com/bunind/gtc-tokens.git
cp -r gtc-tokens/skill ~/.claude/skills/gtc-tokens
```

Then in any Claude Code session, run `/gtc-tokens`. The skill lets you audit a token set against the GTC model, create tokens and components, sync with another `.json` file, or start a new project from the bundled template.

## What's here

- **`skill/`**: the `/gtc-tokens` Claude Code skill. Copy it into `~/.claude/skills/gtc-tokens/` to use. It bundles its own copy of the template so `:new` works standalone, and that copy stays identical to `template/`.

- **`template/`**: the starter token set. `global/`, `theme/`, and `component/` hold one JSON file per scale or component, and `validate.py` checks that aliases resolve, global never aliases out, theme and component never store raw values, no cycles exist, plus the GTC model rules it can see mechanically (no color tokens in component, factual scale keys, one mode type per token, `$value` mirrors the default mode). Run `python3 validate.py`.

CI (`.github/workflows/check.yml`) keeps `skill/template/`, `skill/reference.md`, and `skill/validate.py` byte-identical to their `template/` counterparts and validates both token sets on every push.

- **`template/README.md`**: the GTC rulebook, written for AI agents. It covers the model, taxonomy, modes, and scale keys. Read it before adding or editing a token.

## Skill commands

- `:audit` — review the token set against the GTC model.
- `:create` — add tokens or a component.
- `:sync` — sync tokens with another `.json` file.
- `:new` — start a new GTC project from the template.

## License

[MIT LICENSE](LICENSE)
