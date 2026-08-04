# Design System: flue-repo-assistant

## 1. Visual Theme & Atmosphere

Terminal-inspired dark developer page. Near-black backgrounds, one amber
accent used sparingly for primary actions and highlights, one teal accent for
"evidence / success" semantics. Monospace labels (`font-family: JetBrains
Mono`) create the engineering voice; generous whitespace and a centered
1100px container keep it calm. Cards sit on a slightly raised surface with
hairline borders; the only shadows appear in the hero terminal mock.

## 2. Colour Palette & Roles

| Role | Name | Value | Usage |
|------|------|-------|-------|
| Background | Ink | `#0a0a0b` | Page background |
| Surface | Panel | `#141416` | Cards, section bands |
| Surface Raised | Panel-raised | `#1a1a1d` | Hover states, elevated cards |
| Border | Hairline | `#252528` | Card/nav borders |
| Border Muted | Hairline-faint | `#1c1c1f` | Inner dividers |
| Text Primary | Zinc-200 | `#e4e4e7` | Headings, body text |
| Text Secondary | Zinc-400 | `#a1a1aa` | Paragraphs, links |
| Text Muted | Zinc-500 | `#71717a` | Captions, metadata |
| Accent | Amber | `#f59e0b` | Primary CTA, highlights, section labels |
| Accent Muted | Amber-dark | `#92400e` | Badge backgrounds |
| Evidence | Teal | `#0d9488` | Success/evidence semantics, terminal prompts |
| Evidence Muted | Teal-dark | `#115e59` | Icon chip backgrounds |

## 3. Typography

| Element | Font | Weight | Size | Line Height |
|---------|------|--------|------|-------------|
| H1 | system-ui | 600 | clamp(2.25rem, 5vw, 3.5rem) | 1.12 |
| H2 | system-ui | 600 | clamp(1.5rem, 3vw, 2rem) | 1.25 |
| H3 | system-ui | 600 | 1.125rem | 1.4 |
| Body | system-ui | 400 | 1rem | 1.65 |
| Mono label | JetBrains Mono | 500 | 0.75rem | 1.5 |
| Terminal | JetBrains Mono | 400 | 0.75rem | 1.7 |

Letter-spacing on headings: `-0.02em`. Section labels are uppercase
monospace with `letter-spacing: 0.08em`.

## 4. Component Styles

- **Buttons**: pill (`border-radius: 100px`). Primary = amber bg, near-black
  text, hover `filter: brightness(1.15)` + `translateY(-1px)`. Secondary =
  surface bg, hairline border, hover raises to `--surface-raised`.
- **Cards**: `--surface` bg, hairline border, `--radius-lg` (12px), 28px
  padding, hover `translateY(-2px)`. Icons sit above titles.
- **Navigation**: sticky, `backdrop-filter: blur(16px)` over 85% bg, hairline
  bottom border, 56px height. Logo = amber dot + monospace wordmark. CTA on
  the right. On mobile the link row collapses into a hamburger dropdown.
- **Chips / badges**: pill, `--surface` bg, hairline border, 6px dot in
  front (teal for "live", amber for accents).
- **Terminal mock**: `#0d0d0f` body, traffic-light header bar, monospace
  output. Prompts in teal, commands in zinc-200, output in muted, highlights
  in amber.

## 5. Layout Principles

- Max content width 1100px, centered, 24px side padding
- Sections: `padding: 80px 0` (56px on mobile)
- Card grids: 3 columns desktop → 1 column mobile; security list 2 → 1
- Section header pattern: mono uppercase label → H2 title → muted description
  (max-width 600px)
- Generous gaps (16–24px) — no cramped grids

## 6. Design System Notes for Generation

**Copy this entire block into every baton prompt:**

**DESIGN SYSTEM (REQUIRED):**
- Platform: Web, desktop-first, responsive (768px breakpoint)
- Theme: Dark only — background `#0a0a0b`, surface `#141416`, raised `#1a1a1d`
- Borders: hairline `#252528`; rounded corners 8–12px; pills for buttons/badges
- Primary: amber `#f59e0b` for CTAs + section labels + terminal highlights
- Evidence: teal `#0d9488` for success semantics + terminal prompts
- Text: `#e4e4e7` primary, `#a1a1aa` secondary, `#71717a` muted
- Font: JetBrains Mono (mono labels + terminal) via Google Fonts; system-ui body
- Shadows: none except the hero terminal (`0 20px 60px -20px rgba(0,0,0,.5)`)
- Spacing: sections `padding: 80px 0`; cards `padding: 28px`; container 1100px
- Motion: fade-up scroll reveals (IntersectionObserver), hover lifts, `prefers-reduced-motion` respected
