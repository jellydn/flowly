# Project Vision

> **AGENT INSTRUCTION:** Read this file before every iteration. It is the project's long-term memory.

## 1. Core Identity

| Field | Value |
|-------|-------|
| **Project Name** | flue-repo-assistant docs site |
| **Mission** | Show how a bounded, read-only Flue 2.0 agent answers codebase questions with cited evidence — and teach the safety-through-architecture story |
| **Target Audience** | Developers evaluating the agent, Flue learners, and contributors to the repo |
| **Voice & Tone** | Precise, calm, evidence-first; developer-to-developer |
| **Region** | International (US English) |

## 2. Visual Language

Reference these when writing baton prompts.

- **Primary Vibe**: Clean, minimal, terminal-inspired dark theme
- **Secondary Vibe**: Precise engineering aesthetic (monospace labels, tight grids)
- **Anti-Vibes**: Not cluttered, not marketing-hype, not light-themed

## 3. Technical Setup

- **Output Directory**: `docs/` (the landing page is `docs/index.html`, hand-maintained, served as GitHub Pages)
- **CSS**: Hand-written CSS with CSS variables in `<style>` — no build step, no Tailwind CDN
- **Dark Mode**: Always dark (single theme)
- **Fonts**: JetBrains Mono (mono) via Google Fonts; system-ui stack for sans

## 4. Live Sitemap

Update this when a page is successfully generated.

- [x] `docs/index.html` — Landing page: hero, stats, tool kit (five tools + meta-tools), observe→act→reflect loop, beyond-the-loop cards, architecture, security, docs links, getting started + quick wins (refreshed Aug 2026)

### Planned (roadmap)

- [ ] `docs/benchmark.html` — Eval benchmark reference: scenarios, scoring, CLI commands
- [ ] `docs/event-router.html` — Event router reference: config shapes, filters, supported events
- [ ] `docs/architecture.html` — Deep-dive architecture page linking ADRs and the codemap

## 5. Roadmap (Backlog)

### High Priority
- [ ] `docs/benchmark.html` — benchmark CLI, suite format, scoring dimensions, review flow

### Medium Priority
- [ ] `docs/event-router.html` — route config, filters, dedupe, supported events
- [ ] `docs/architecture.html` — end-to-end data-flow diagram with ADR cross-links

### Low Priority
- [ ] `docs/reliability.html` — error taxonomy, retry policy, fallback behaviour

## 6. Creative Freedom

When the roadmap is empty, follow these guidelines to add pages:

1. **Stay on-brand** — dark, monospace-accented, precise
2. **Enhance the core** — every page must serve developers using or extending the agent
3. **Naming convention** — lowercase, descriptive filenames (e.g. `benchmark.html`)

### Ideas to Explore
- [ ] `docs/security.html` — path confinement and budget deep dive

## 7. Rules of Engagement

1. Do NOT recreate pages already marked `[x]` in Section 4
2. ALWAYS update `.design/next-prompt.md` before completing an iteration
3. Remove consumed ideas from Section 6
4. Copy header/nav/footer from the most recent page — never regenerate
5. All internal links must point to real pages
