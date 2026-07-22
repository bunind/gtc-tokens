# GTC Tokens - starter template

> **Source of truth:** [buninux.com/design-tokens](https://buninux.com/design-tokens) — the canonical GTC spec. Consult it if anything here is ambiguous.

A design system's token starter built on the **GTC model** [Global / Theme / Component]. This README is written for AI agents: read it before adding, editing, or wiring a token.

## What GTC model is

Three groups. A value travels only as far as it needs to.

- **Global** — the primitive scale. Raw colors, sizes, weights, easings. Aliases nothing.
- **Theme** — how things *look*. Light/dark decisions. Every token aliases Global.
- **Component** — how things are *built and sized*. Per-component structural tokens [radius, border, size-unit, font-size] that reference **Global**. Component never ships color tokens — a component's look [surface, text color] lives in Theme [`theme.button.*`].

GTC is a **non-linear** model: `theme` and `component` branch out from `global` in parallel, each connecting to its own members along a specificity axis [general → specific]. They are siblings, not a chain — neither sits "under" the other.

```
global.                  [primitives · the source of truth, no aliases]
│
├── theme.               [how it looks · modes: light / dark]
│   ├── surface
│   ├── text
│   ├── icon
│   ├── border
│   ├── button
│   └── input
│
└── component.           [how it's built & sized · size modes]
    ├── button
    └── input
```

`theme` ships shared looks [`surface`, `text`, `icon`, `border`] plus per-component `button` / `input`; `component` ships `button` / `input`. Extend either with new members [`card`, `badge`…] the same way [see Working the tokens].

## File layout

Three top-level folders = the three groups. Each scale / component is its own folder with its own JSON file, so every change is isolated and easy to trace.

```
gtc-tokens-template/
├── global/                         [primitives · no aliases, one folder per token type]
│   ├── color/color.json            [palettes + opacity]
│   ├── typography/typography.json
│   ├── effects/effects.json        [shadow + blur]
│   ├── radius/radius.json
│   ├── border/border.json          [border widths + stroke styles]
│   ├── size-unit/size-unit.json    [unit scale · spacing, gaps, sizes]
│   ├── motion/motion.json          [easing + duration]
│   └── z-index/z-index.json        [stacking order · roles]
├── theme/                          [modes: light / dark]
│   ├── surface/surface.json        [elevation: page, container, overlay, modal]
│   ├── text/text.json              [default, secondary, muted]
│   ├── icon/icon.json              [default, secondary, muted]
│   ├── border/border.json          [default, secondary]
│   ├── button/button.json
│   └── input/input.json
└── component/                      [modes: small / medium / large]
    ├── button/button.json
    └── input/input.json
```

Every file keeps the full name-path [`global.color…`, `theme.button…`] so aliases resolve when the files are merged. Merge order doesn't matter.

## Modes

A mode is a property that tells a token which value to use in a given context. One token holds one value per mode; switch the mode and the element repaints/resizes.

- **Theme modes:** `light`, `dark` [and others when needed, e.g. high-contrast].
- **Component modes:** size modes — `small`, `medium`, `large` [add `xsmall` / `2xlarge` only when a component needs them]. Mode values live under `$extensions.mode` keys, each mapping to a factual global token [e.g. `small → {global.size-unit.16}`]. A mode word may also appear in a token name — `dark` in `theme.surface.dark.page` is an ordinary Classifier/Identifier for the level it precedes, same as `dark` naming a dark palette variant. Name and mode keys are independent; a mode word in the path is never wrong by itself.

Modes are selected by **scope**: flip one component or the whole page at once. A single token can answer to more than one mode [e.g. a color-scheme mode and a size mode], activated independently.

```
   one token · one value per mode

   theme.input.surface     ← [swaps on theme mode]
   ├── light   → global.color.base.0
   └── dark    → global.color.base.9

   component.button.size   ← [swaps on size mode]
   ├── small   → global.size-unit.16
   ├── medium  → global.size-unit.24
   └── large   → global.size-unit.28
```

Modes live under `$extensions.mode`. `$value` carries the default [light / medium] so a mode-unaware tool still resolves the token:

```json
"surface": {
  "$type": "color",
  "$value": "{global.color.base.1}",
  "$extensions": { "mode": {
    "light": "{global.color.base.1}",
    "dark":  "{global.color.base.9}"
  } }
}
```

## Alias direction

- **Global** aliases nothing — the source of truth for raw values.
- **Theme** and **Component** reference Global, and may reference each other in edge cases — see below.
- The one rule that never bends: a token can never resolve back to itself, directly or through a chain — **no cycles**.
- A value resolves straight into a Component, or passes through a Theme first — only as far as it needs to go.

The default flow: Component aliases Global for structural values; a component's look lives in Theme [`theme.button.*`], never as Component color tokens. The edge case: a structural value that must switch on a theme mode routes through Theme first. Say text should be bolder in light mode and thinner in dark: `component.button.font-weight → theme.button.font-weight`, with modes `light → {global.typography.font-weight.bold}`, `dark → {global.typography.font-weight.regular}`. The group is decided by *what the value varies by* [theme mode → Theme], not by token type.

`validate.py` enforces this: every `{alias}` resolves, no `global.*` token holds an alias, no `theme.*` / `component.*` token stores a raw value, and no reference cycle exists. It also enforces the model rules it can see mechanically — no color tokens under `component.*`, factual numeric scale keys [`size-unit.12` = `"12px"`, `opacity.8` = `0.08`; effects keys are elevation roles and exempt], no theme and size modes mixed in one token, and `$value` mirroring the default mode [`light` / `medium`] — and warns when a mode-carrying token's own path contains one of its mode names. Run `python3 validate.py`.

## Working the tokens

**Where does it go?** Pick the group by what varies:

```
fixed raw value [hex, px, weight…]         → global/<token-type>/<token-type>.json
varies by light / dark, or a semantic look → theme/<component>/<component>.json
varies by size, or per-component structure → component/<component>/<component>.json
```

Global holds raw values and aliases nothing. Theme and Component never store raw values — Theme aliases Global for a look; Component aliases Global for structure [Theme only in the mode-dependent edge case above].

**The typography exception:** `font-family` needs no component token — a component binds text straight to `global.typography.font-family.*` [the typeface is app-wide]. Add `component.<x>.font-family` only when a component genuinely diverges; its absence is correct, never a gap.

> **Figma only — variant-switcher variables.** A Figma library may hold STRING variables whose per-mode values are variant names — `badge/item/size`: `XSmall → "XSmall"`, or `list/item/badge-size` pointing a nested badge at a size per mode. They exist to switch a nested instance's variant when a mode flips — a Figma mechanism, not a design token. They stay in Figma, are **excluded from the DTCG export**, and are never audit findings [not a raw-value violation]. Pure-code token sets never contain them.

**Common requests → what to edit.** Always finish with `python3 validate.py`.

- *"Change the brand color / a primitive"* → edit `global/color/color.json` [or the relevant `global/<token-type>`]. Every token that aliases it updates automatically.
- *"Make the button bigger / retune a size"* → edit `component/button/button.json`; point the `size` / `spacing-gap` mode values at different `{global.size-unit.*}`.
- *"Add a dark-mode value for X"* → in the theme token, set `$extensions.mode.dark`; keep `$value` mirroring the `light` value [see Modes].
- *"Add a danger / semantic variant"* → add a theme token aliasing `{global.color.red.3}` [e.g. `theme.button.danger.surface`] — the variant's look is complete in Theme; Component holds no color tokens to repoint.
- *"Add a new component [e.g. card]"* → copy `component/button/` to `component/card/`, rename the `button` key to `card`, repoint the structural aliases at `{global.*}` per size mode [e.g. `component.card.radius` from `{global.radius.*}`], and add `theme/card/` if it needs its own look [e.g. `theme.card.surface`].

**Authoring shape** [DTCG]: a token is `{ "$type": …, "$value": … }`. Alias another token with `"$value": "{group.path.to.token}"`. For modes, put per-mode values under `$extensions.mode` and mirror the default in `$value`.

## Value type formats

| `$type`       | format                     | example                                     |
|---------------|----------------------------|---------------------------------------------|
| `color`       | hex string, 8-digit = alpha | `"#6366f1"`, `"#0000001a"`                 |
| `dimension`   | px string                  | `"16px"`                                    |
| `number`      | unitless number            | `1.5` [line-height, opacity 0–1, z-index]   |
| `fontWeight`  | number                     | `500`                                       |
| `fontFamily`  | string                     | `"Inter, sans-serif"`                       |
| `strokeStyle` | keyword string             | `"solid"` / `"dashed"` / `"dotted"`         |
| `duration`    | ms string                  | `"200ms"`                                   |
| `cubicBezier` | `[x1, y1, x2, y2]`         | `[0.42, 0, 0.58, 1]`                        |
| `shadow`      | object                     | `{ color, offsetX, offsetY, blur, spread }` |
| alias         | `{name-path}` of any token | `"{global.color.base.5}"`                   |

## Tokens naming taxonomy

Every name is a path of levels plus a value at the end. Each level narrows what the token means, so the number of levels equals the token's specificity. A good taxonomy comes down to one best practice: **balance clarity against simplicity**. Use the minimum number of levels required to describe a token, and add a level only when removing it would leave the token ambiguous. The opposite is a *rigid grammar*, where one fixed chain is applied to every token, so each name carries the same slots whether it needs them or not.

`Group . Element . Classifier . Identifier . State` → `value`

```
   theme.button.primary.alpha.hover
   ├── theme    Group       global / theme / component
   ├── button   Element     UI thing: button, input
   ├── primary  Classifier  variant: primary, danger
   ├── alpha    Identifier  distinguishing tag
   └── hover    State       interaction: hover, pressed
```

**The value is never a level.** Any level *below* Group can be the leaf that carries it — i.e. the segment that resolves to a `{global.*}` alias or a raw value. There is no separate "property" slot: in `component.button.font-size`, `font-size` is the Identifier leaf and it holds the value; in `theme.input.surface`, `surface` is the Identifier leaf; in `theme.button.primary.alpha.hover`, the `hover` State leaf holds it. Property-like words [`surface`, `text`, `border`, `font-size`, `spacing-gap`, `page`, `container`] are Identifiers that distinguish *which* aspect of the token, and whichever is last carries the value. Separators follow one rule: **a dot separates levels, a hyphen joins words inside one level** [`size-unit`,`font-size`, `spacing-gap` are single levels; `surface.page`,`base.1`, `font-size.16` are level boundaries — never `surface-page` or `base-1`].

| Level      | Meaning                                        | Example             |
|------------|------------------------------------------------|---------------------|
| Group      | Always first: `global` / `theme` / `component` | `theme`             |
| Element    | UI element [button, input, surface, icon];     | `button`            |
| Classifier | Alternative variant or category of token       | `primary`, `danger` |
| Identifier | Distinguishing tag or property                 | `light`             |
| State      | Interaction state                              | `hover`, `pressed`  |

**Classifier** defines alternative token variants or categories [e.g. `secondary`, `tertiary`]. Use it only after the Group or Element level. Include it where the value is variant-specific — appearance/semantic tokens that pick a variant's look [`surface`, `text`] — and leave variant-agnostic structural tokens bare [`spacing-gap`, `radius`, `size`], since geometry is the same across variants. A single-variant component may omit the Classifier entirely:

```
theme.button.primary.surface          variant-specific → classified
component.button.font-size            structural      → bare
component.button.radius                structural      → bare
theme.input.surface                    single variant  → omitted
```

The taxonomy rests on three rules:

1. **Why before where.** A name reflects *why* a token exists before *where* it's used, encoding the full path down to its value.
2. **A clear order, with no missing group.** Levels keep their order and every name starts with a Group: `Group → Element/Classifier/Identifier/State → value`, or the short `Group → value`. Never lead with a value or drop the Group. The Group may be carried by the container instead of the path: in Figma the *collection name* is the Group and variable paths start at Element [`avatar/size` in a `component` collection = `component.avatar.size`] — that satisfies this rule.
3. **Design role, not screen.** Name tokens and modes by design role, never by screen, feature, or layout — keep the abstraction high. `color` · `button` · `badge` · `dark` ✓ — `card-badge` · `sidebar-text` · `login-spacing` · `dashboard` ✗

## Token types

Global holds the full set of token types [DTCG `$type`s]. Related types share a subgroup [one visual aspect each — color, typography, effects], and Theme and Component reuse the same subgroups, so a token type sits in the same slot everywhere. The full catalog:

- **size-unit**: unit scale values for spacing, gaps, and sizes
- **color**: UI hierarchy, semantic meaning, and brand presence
- **opacity**: transparency and dimming for UI elements
- **font-family**: the typefaces and fonts
- **font-size**: font scaling and text-size values
- **line-height**: vertical rhythm across the UI
- **font-weight**: weight scaling across text elements
- **letter-spacing**: spacing between letters
- **radius**: border radius for UI surfaces and elements
- **border**: border thickness and stroke styles for UI elements
- **shadow**: shadow appearance and elevation
- **blur**: background-blur for UI surfaces
- **motion**: transition easings and animation timings
- **z-index**: stacking order for modals, overlays, and floating elements

These are *token types*, not folders. Related types share one folder/file under `global/`, so there is no `opacity/` or `font-size/` folder — open the file that owns the type:

| Token type(s)                                                    | File                                |
|------------------------------------------------------------------|-------------------------------------|
| size-unit                                                        | `global/size-unit/size-unit.json`   |
| color, opacity                                                   | `global/color/color.json`           |
| font-family, font-size, line-height, font-weight, letter-spacing | `global/typography/typography.json` |
| radius                                                           | `global/radius/radius.json`         |
| border                                                           | `global/border/border.json`         |
| shadow, blur                                                     | `global/effects/effects.json`       |
| motion                                                           | `global/motion/motion.json`         |
| z-index                                                          | `global/z-index/z-index.json`       |

## Scale keys

Each token type's keys are the actual scale. **Numeric keys are factual** — `size-unit.12` is `12px`, `font-size.16` is `16px`, `radius.8` is `8px`. The key *is* the value, so an agent never has to guess. The steps listed below are the starter template's defaults, **not a closed set**: a project extends any scale with new factual keys (`size-unit.14`, `font-size.11`, new ramp steps) whenever its design uses the value — membership in these lists is never an audit finding. Conventions per type:

- **color** — neutral ramp `base.0…base.10`, light → dark [`base.0` = `#ffffff`, `base.10` = `#0a0a0a`]. Hue ramps `brand`, `blue`, `red`, `green`, `yellow`, `orange`, `teal`, `purple` each run `1…5`, light → dark [`3` is the mid/base hue].
- **opacity** — nested under color, so the path is `global.color.opacity.N`, **not** `global.opacity.N`. Keys `0, 8, 16, 24, 32, 48, 64, 80, 100` = percent; value is `0–1`.
- **size-unit** — `0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 40, 44` [px].
- **radius** — `0, 4, 8, 12, full` [`full` = `1000px`, a pill].
- **border** — widths `0, 1, 2, 4` [px]; stroke styles `style.{solid, dashed, dotted}`.
- **typography** — `font-size` is numeric [`12…30`, px]; `line-height` and `letter-spacing` use semantic role keys `title / text / label`; `font-weight` is `regular / medium / bold`; `font-family` is `sans / mono`.
- **effects** — `shadow.1…3` and `blur.1…3` [low → high elevation].
- **motion** — `easing.{linear, ease-in, ease-out, ease-in-out}`, `duration.{fast, normal, slow}`.
- **z-index** — role keys `base, dropdown, sticky, overlay, modal, toast, tooltip` [low → high].
