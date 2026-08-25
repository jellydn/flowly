# 0005. Transcript-based static showcase and Pages asset conventions

Date: 2026-08-25

## Status

Accepted

## Context

Flowly needed a marketing surface, but its interface is the terminal: there is
no dashboard, no settings page, and nothing to screenshot. The default
product-showcase approach (browse a running web UI, capture screenshots and
GIF walkthroughs) has no subject here. Fabricating UI mockups would violate
the project's own honesty stance — the agent refuses to state claims it did
not verify, so its marketing site should not either.

Separately, the repository publishes a website from `docs/` via GitHub Pages
as a **project site** (`https://jellydn.github.io/flowly/`, source `main`,
path `/docs`). Project pages are served under a subpath, so any absolute
asset reference (`/favicon.svg`) resolves to the domain root
(`jellydn.github.io/favicon.svg`) and 404s. The first version of the favicon
package shipped with absolute paths and was caught by review against the
live site, where `https://jellydn.github.io/favicon.svg` indeed returns 404.

## Decision

Two related conventions for web artifacts in this repository:

- **Showcase site (`docs/showcase/`) is plain static HTML/CSS with verbatim demo
  transcripts instead of screenshots.** The "screenshots" are the real output
  of the deterministic, key-free demos (`demo/doc-aware-demo.ts`,
  `demo/capstone-demo.ts`) rendered in styled terminal frames. There is no
  build step, no framework, no external requests, and no JavaScript; the
  three pages share one stylesheet using the project brand palette. Anything
  the demos do not print is not claimed. It lives under `docs/`, the GitHub
  Pages root, so the existing branch-based Pages publish flow serves it at
  `/showcase/` alongside the landing page with no deploy workflow.
- **All assets served from `docs/` (the Pages root) use relative paths** —
  favicon links, `site.webmanifest` `start_url` (`"./"`), and PWA icon
  `src`s — so they resolve correctly at any base path. This holds unless the
  site moves to a custom domain at the domain root.

## Consequences

### 📋 Positive

- The showcase cannot drift from reality: regenerating the demos regenerates
  the claims, and every statistic on the site traces to README or demo output.
- Zero build tooling and zero dependencies for both sites; the showcase is
  published by the same `main` → `/docs` Pages flow as the landing page.
- Relative paths make `docs/` correct under the Pages subpath today and
  under a future custom domain or local subpath preview without edits.
- The honesty stance (cited answers, no fabrication) extends coherently from
  the agent to its marketing.

### 📋 Negative

- Terminal transcripts are text-dense and less immediately eye-catching than
  product screenshots would be for a GUI product; the approach only works
  because the product's surface genuinely is the terminal.
- Nav and footer markup is duplicated across the three showcase pages — the
  price of "no build step"; extracting it would require introducing one.
- Relative paths must be remembered for every future file added under
  `docs/`; an absolute path will look correct locally (served at `/docs/` or
  `/`) and only break on the deployed project page.
