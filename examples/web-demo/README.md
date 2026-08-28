# Validation diagnostics — a browser demo

Every fault in one pass, with no server and no network. The schema is resolved, linked and compiled
in the browser; the document is validated against it; each diagnostic carries a code, a data path,
what was expected and what was found, and the position it was found at.

Built for [tson.io](https://tson.io) and styled to match it — the palette is lifted from that site's
own stylesheet, so it drops in without a reskin.

## Build

```bash
npm run demo:web          # from the repository root
```

Writes three files to `dist/`: `index.html`, `demo.js`, `demo.css`. No framework, no runtime
dependency, nothing to configure — copy the directory to any static host.

The build states the page's own gzipped size back into the HTML, so the claim in the footer cannot
drift from the artifact it describes.

## Serve

ES modules are subject to the same-origin policy, so `file://` will not work — the browser blocks
the module script and the page stays blank. Any static server does:

```bash
npx serve examples/web-demo/dist      # or python3 -m http.server, or your own
```

## What it demonstrates

- **`validate()` collects.** A fail-fast read stops at the first problem; this reports all of them,
  which for an LLM retry loop is the difference between one round trip and ten.
- **The whole pipeline runs client-side.** `@ltr8/tson/stdlib` embeds `meta-kernel`, `meta.tn` and
  `core.tn` as source text, so a user schema compiles in the browser with no fetch.
- **A schema is optional.** Clear the _read against_ box and the document is read with no schema at
  all — base syntax and the built-in type vocabulary (Class 1). That path never loads the compiler.
- **A library gap is not a verdict.** `NOT_IMPLEMENTED` is styled differently and worded
  differently, because it says nothing was checked rather than that the document is wrong.

## Also a test

The build targets `platform: 'browser'`, which makes it a check as much as a demo: under the browser
condition `@ltr8/tson/source` cannot be resolved at all, and esbuild refuses a Node built-in rather
than shimming one. **A build that succeeds is a build carrying neither.**
