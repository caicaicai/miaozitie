# Repository Guidelines

## Project Structure & Module Organization
This repo is a static, browser-only Chinese writing practice site. Core pages live in the root:
- `index.html`: stroke practice (main experience).
- `chaozi.html`: compact copy mode for articles.
- `pinyin.html`: article pinyin annotation.
Shared assets are also in the root: `hanzi-writer.min.js`, `pinyin-pro.min.js`, and `ziku.txt` (character data). Deployment notes are in `DEPLOYMENT.md`.

## Build, Test, and Development Commands
There is no build step or package manager. Open the HTML files directly in a browser.
- `index.html` (main page)
- `chaozi.html` (copy mode)
- `pinyin.html` (pinyin mode)
For local testing with relative assets, a simple static server is fine:
- `python -m http.server 8000` (then visit `http://localhost:8000/`)

## Coding Style & Naming Conventions
- Indentation: 4 spaces in HTML, CSS, and JS blocks (match existing files).
- Keep styles and scripts inline within each HTML page unless there is a clear reuse case.
- File naming: lowercase, short, descriptive (e.g., `pinyin.html`).
- Avoid reformatting minified vendor files (`*.min.js`) unless intentionally updating them.

## Testing Guidelines
No automated tests are configured. Validate changes manually:
- Load each page and exercise key actions (character input, pinyin toggle, print layout).
- Verify print layouts in the browser print preview for A4 single/dual column modes.

## Commit & Pull Request Guidelines
Recent commits are short, descriptive, and often in Chinese; some use prefixes like `style:`. Follow that pattern and keep messages focused (one change per commit where possible).
PRs should include:
- A brief description of the change and the affected page(s).
- Manual testing notes (what you clicked/printed).
- Screenshots or print-preview captures for any UI or layout changes.

## Security & Configuration Tips
This is a static site with no secrets or runtime configuration. Keep external dependencies pinned to local files or vetted CDN versions, and note version changes in the PR description.
