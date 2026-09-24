# Design principles and language

English | [中文](principles-and-language.zh.md)

## Design principles
1. Reuse Harness public primitives from `@deepseek-ai/dsh-client-ui-primitives`: `MarkdownText`, `Button`, `Pill`, `Modal`, `Tooltip`, `Input`, `StateDot`, icons, and the dismissal/max-height hooks. Team does not reimplement them; the composer textarea is the single-line `Input` exception, and `MessageText` is no longer part of the set — the shipped primitive was removed in 0.1.5, so `TeamMessage` renders plain bodies itself and delegates Markdown to `MarkdownText`.
2. Use only aliases actually defined by `@deepseek-ai/dsh-client-ui-theme`: `--dsw-alias-label-*`, border, background, interactive, state, shadow, and specific tokens. Team variables may only be derived values such as avatar hue. Undefined `var()` values silently fall back to `initial`, so never guess token names.
3. Prefer chat density over assistant-document density: body text is the 14px scale and Markdown spacing is tightened locally.
4. Use progressive disclosure: quiet borders and no fill by default; hover/focus elevate feedback; secondary information uses tertiary color.
5. Durable mutations are not optimistic. Preserve input on failure and render the next Host projection, using `mergeChannelView` rather than replacing the whole view.
6. Every custom composite control has roles, ARIA state, and a complete keyboard path.

## Design language alignment (DSH 0.1.7)
The Team Client renders inside the shipped DSH shell, so it must speak the
base UI's design language. This section is the durable contract; the
repeatable mechanical audit is `node scripts/audit-ui-parity.mjs` (run it
after any visible-UI change and after every DSH upgrade — the shipped
reference tripwires fail when the harness checkout no longer defines the
primitives this parity relies on).

| Dimension | Rule | Shipped reference |
| --- | --- | --- |
| Icon-only control | 28×28 circle, `border-radius: 999px`, `corner-shape: round`, transparent fill, hover `--dsw-alias-interactive-bg-hover-solid` (composer) / `--dsw-alias-interactive-bg-hover` (sidebar) | `InputBar.module.css .add`, `SidebarRoot.module.css .iconButton` |
| Primary round action (send/stop) | 34×34 circle, `--dsw-alias-button-info-fill`, static `#fff` glyph, hover info-hover, disabled `opacity .4` + `cursor: default`, `translateY(-2px)` seat compensation | `InputBar.module.css .primary` |
| List rows | 8px radius; `aria-current="page"` leaf fill; hover `--dsw-alias-interactive-bg-hover` | `SidebarRoot.module.css .panelRow` |
| Queue/result row (two-line) | Full-width button, 8px radius, 8px horizontal inset, one line per fact with its own ellipsis, hover `--dsw-alias-interactive-bg-hover`, inset focus ring. Typography grades the two lines: subject 14px/22px primary, provenance/meta 12px/18px tertiary with the significant segment (the Channel name) stepped up to secondary 600, and an inline `Task #N` as a 6px, 11px/15px chip. Which line carries which fact follows the surface's own information order. | `ui-workspace/src/client/rows/Rows.module.css .searchResultRow` (8px radius, 8px inset, full-width button, hover fill, 14px title over 12px meta) |
| Capsules and circles | Every effectively uncapped radius — `border-radius: 50%`, `999px`, or a pill radius that equals half the box — pairs `corner-shape: round` in the same block. The platform curves all rounded surfaces along `superellipse(1.5)`, which deforms a circle into a squircle and squares capsule ends off; shipped pairs 100% of its full-round blocks and the audit fails an unpaired one. | `ui-theme/src/styles/corner-shape.css`; `Tag.module.css`, `StateDot.module.css`, `SidebarRoot.module.css .iconButton` |
| Count badge | One capsule for every count the Human reads, declared once in `countBadge.module.css .badge`: 18px with `min-width: 18px`, `border-radius: 999px` paired with `box-sizing: border-box` (one digit stays a circle instead of padding out to an oval), `--dsw-alias-state-business-primary` fill and `--dsw-alias-label-primary-foreground` text, hidden at zero, `99+` past it, and the number rides the control's accessible name (`aria-label`), never the visual badge alone. | `Tag.module.css` (read-only capsule language); `countBadge.module.css .badge` |
| Chips | 6px radius, `--dsw-alias-interactive-bg-hover` fill | `composer-editor.module.css .reference` (the 6px inline reference; shipped keeps it transparent with a business-tinted hover) |
| Control gap | 12px between sibling controls inside a composer/sidebar toolbar group | `InputBar.module.css .tools/.trailing` |
| Keyboard focus | Visible ring: `outline: 2px solid var(--dsw-alias-label-primary)`, rows `outline-offset: -2px`, icon-size controls `1px`. `outline: none` is allowed only with a ring-grade replacement in the same rule — outline, `box-shadow` spread, `border-color` on a bordered control, or `text-decoration` on a text control; background/color alone is hover feedback, not a focus indicator (shipped leaves the UA ring on small controls instead). Ring color follows the control accent: `label-primary` for rows and icon controls, `business-primary` for input-adjacent composer/Thread controls (shipped anchors business to inputs, links, and table scroll). Exemption: `aria-activedescendant` listbox rows (mention popup) — focus stays on the text input, selection shows via `[aria-selected]`. | `SidebarRoot.module.css .panelRow:focus-visible`; `InputBar.module.css .add` (keeps the UA ring, no `outline: none`) |
| Icon semantics | Glyphs carry meaning from the base UI: `+` = command menu, paperclip = attach, pencil = edit. Never repurpose a shipped glyph for a different action. 0.1.7 renamed the icon set — the size left the name and the weight entered it (`Icon*OutlineRegular`, `Icon*OutlineMedium`, `Icon*OutlineArtwork`), with the size passed through the `size` prop — and removed the shipped composer's own attach control, so the Team composer's paperclip is this repository's own convention. | `InputBar.tsx` (`+` opens the command menu via `aria-haspopup="listbox"`) |
| Mode control (composer) | A control that changes what the primary action *means* — as-task — is a **mode**, not an action: it keeps a visible word label, shares the left group with the attach control, and reads as a 28px-high pill (24px radius, 13/20px weight 500, transparent fill, hover `--dsw-alias-interactive-bg-hover`, on-state `--dsw-alias-button-primary-fill` with `--dsw-alias-label-primary-foreground` under `aria-pressed`). The word is hidden — never deleted — only inside a narrow-container branch (`@container (max-width: 460px)`), where `aria-label`, `title`, and `aria-pressed` keep the mode legible to assistive tech and the keyboard. | `InputBar.module.css .row` (size container); mode chrome is `.select` (28px, 8px radius, 13/20 medium) and the composer narrows control gaps at `@container (max-width: 560px)` |

> TODO: DSH 0.1.7 moved four references this table mirrors, and Team has not
> aligned with them yet — each awaits a decision:
> - list rows: shipped `.panelRow` is now 12px radius, while Team rows still
>   declare 8px;
> - mode chrome: the labeled chip and its 460px label cut were deleted, so the
>   composer keeps its word label at every width and shrinks control gaps to
>   8px below 560px, while `asTaskPill` is still a 24px pill;
> - composer body: shipped bottom padding is 4px, while Team's card padding is
>   its own;
> - icon weight: 14–16px controls and menus use `Icon*OutlineMedium`, while
>   Team's 14px composer icons are `Icon*OutlineRegular`.

Consistency verdicts are recorded per surface in this document (see
Component contracts below); when a verdict is "accept the drift", say why
there — the audit script reports mechanical drift, the document owns the
judgment.
