# Repository Guidelines

## Project Structure & Module Organization
This repo is a static, browser-only Chinese writing/learning practice site for elementary students. `index.html` is a dedicated navigation homepage (card grid linking to every tool); it has no practice UI of its own. Each tool lives in its own page in the root:
- `bihua.html`: stroke-by-stroke practice (originally `index.html`; renamed when the homepage became a nav page).
- `zice.html`: interactive handwriting self-quiz using Hanzi Writer's `quiz()` API (draw-and-check, not just animation).
- `chaozi.html`: compact copy mode for articles.
- `pinyin.html`: article pinyin annotation.
- `moxie.html`: "read the pinyin, write the character" printable dictation sheet (complements `pinyin.html`'s character-to-pinyin direction).
- `tingxie.html`: spoken dictation practice (speech synthesis + printable answer sheet).
- `mingtie.html`: name sticker/label generator.
- `kousuan.html`: mental-math drills (numpad / handwriting recognition via `tf.min.js` + MNIST model in `mnist-model/` / voice input).
- `yunsuanbiao.html`: multiplication/addition/subtraction reference tables, optionally with randomly blanked cells for fill-in practice, printable.
- `shizhong.html`: analog-clock time-reading practice (interactive quiz + printable worksheet); clock faces are pure CSS/JS (rotated divs), no canvas/SVG/library dependency.
- `gushi.html`: printable classical-poem cards (recite mode with auto pinyin via Pinyin Pro, or blank-line dictation mode); poem text is hardcoded curated public-domain content — double-check exact wording against a reliable source before adding more poems.
- `kechengbiao.html`: class timetable generator; the generated table cells are plain `<input>` fields the user types directly into (no per-subject data model).
- `renminbi.html`: RMB "make the amount" interactive drill (click denominations to match a random target); amounts are tracked internally in 角 (jiao) integer units to avoid floating-point issues.
- `xingjinzi.html`: multiple-choice quiz for commonly-confused look-alike characters (形近字), e.g. 己/已/巳, 做/作/坐/座, 燥/躁/操/澡; question bank (66 items as of this writing) is hardcoded curated content — verify sentence grammar and character correctness carefully before adding more items, and run the "extract questionBank + validate" style check (blank count, unique 4 options, answer present, single-hanzi options, no duplicate sentences) after edits.
- `ai-zhushou.html`: **experimental**, the only page that breaks the "no build step, few-MB dependencies" pattern. Its job is now narrow: show the size/license/device warnings, load the model via `ai-engine.js`, and provide a simple multi-turn chat debug window to sanity-check the model. It does NOT implement task-specific generation features itself anymore — those live in the individual tool pages that use them (see `ai-engine.js` below).
- `ai-engine.js`: shared ES module (imported via `<script type="module">`, not npm) that owns all Transformers.js / MiniCPM state: `loadAIModel()` (memoized pipeline load, no duplicate downloads), `generateWithAI(messages, options)` (one-shot chat-style generation), `supportsWebGPU()`, and `hasModelBeenLoadedBefore()` (a `localStorage` flag set after any successful load, used by other pages to decide whether to show their "🤖 AI 辅助生成" UI or a "go load it first" link). It imports `@huggingface/transformers` directly from the jsDelivr CDN and runs a community ONNX export of MiniCPM5-1B (`Mike0021/MiniCPM5-1B-ONNX-Web`, ~500MB+ q4-quantized, not an official onnx-community export) fully client-side via WebGPU/WASM. The model is fetched at runtime from the Hugging Face Hub — it is intentionally NOT committed to this repo or bundled into the Pages deploy, both because of its size and because Cloudflare Pages caps individual assets at 25 MiB. The `MODEL_ID` constant inside this file is the single point to update if the community export disappears or a better one appears.
- Pages that integrate an "AI 辅助生成" mini-feature (currently `tingxie.html` and `moxie.html`, both in their "自定义内容" tab): each adds its own `<script type="module">` that imports from `./ai-engine.js`, calls `hasModelBeenLoadedBefore()` on load to render either a locked hint (linking to `ai-zhushou.html`) or a small generation form, and re-renders on the `storage` event so other already-open tabs pick up a just-completed model load without a manual refresh. Treat all generated output as an unreviewed draft only (small 1B model, weak instruction-following) — keep the "please review before use" framing if you touch these blocks. Follow this same pattern if adding AI-assist to more pages, rather than re-implementing model loading locally.
- Model license reminder (applies to both files above): OpenBMB's General Model License — free for research, requires registration for commercial use. Keep the license link/warning visible in `ai-zhushou.html`.

Shared files, used across multiple pages (a deliberate exception to "inline everything", see below):
- `common.css`: shared header/back-link/footer styles for every tool page (not used by `index.html`, which has its own standalone hero + card styles).
- `ziku-data.js`: shared `gradeChars`/`allChars` character-bank data, used by `bihua.html`, `tingxie.html`, `zice.html`, and `moxie.html`.
- `hanzi-writer.min.js`, `pinyin-pro.min.js`, `tf.min.js`, `ziku.txt` (character data reference).

Every tool page's header only shows a single "← 返回首页" link back to `index.html`; there is no longer a multi-page nav bar. Deployment notes are in `DEPLOYMENT.md`.

## Build, Test, and Development Commands
There is no build step or package manager. Open the HTML files directly in a browser, starting from `index.html`.
For local testing with relative assets, a simple static server is fine:
- `python -m http.server 8000` (then visit `http://localhost:8000/`)

## Coding Style & Naming Conventions
- Indentation: 4 spaces in HTML, CSS, and JS blocks (match existing files).
- Keep styles and scripts inline within each HTML page unless there is a clear reuse case (e.g. `common.css`, `ziku-data.js` — shared across multiple pages, extracted to avoid drift/duplication).
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
