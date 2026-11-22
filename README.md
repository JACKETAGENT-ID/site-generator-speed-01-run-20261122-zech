[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/JACKETAGENT-ID/site-generator-speed-01-run-20261122-zech/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/JACKETAGENT-ID/site-generator-speed-01-run-20261122-zech/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

# Faster static site builder

A fast drop-in for makefun-site 1.0.0: `solve.js` returns, for every case,
byte-identical output to makefun-site 1.0.0 — every page's `index.html`, the
index and tag pages, `build-report.txt` and each static file — only faster.
`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

- **Markdown in one pass.** The body is scanned line by line straight into
  the output string: no token arrays, no per-line allocations, and plain-text
  runs are escaped in chunks instead of one regex replace per character.
- **Hand-written front-matter scanner.** Index-based, no regex per line, and
  the body is a slice of the input, never split and re-joined.
- **Compiled templates.** Each template is parsed once and compiled into a
  small JS function (cached across cases by name and source); rendering is
  direct string building over scope chains, with no node-tree walk.
- **Cheap text rules.** `slugify` results are cached, word counting and link
  resolution skip regexes on their hot paths, and `\r\n` normalisation is
  skipped entirely when a file holds no `\r`.

## Layout

- `solve.js` — the whole generator: front matter, Markdown, templates and
  the build pipeline. Dependency-free ES module, exports `run(input)`.
- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/answers.json`).
- `package.json` — `{"type": "module"}` so `solve.js` loads as an ES module.

## License

MIT — see [LICENSE](LICENSE).
