/**
 * The TSON validation-diagnostics demo.
 *
 * Everything here runs in the browser: no server, no network. `@ltr8/tson/stdlib` carries the three
 * bundled schemas (`meta-kernel`, `meta.tn`, `core.tn`) as embedded text, so a user schema resolves,
 * links and compiles client-side, and a data document is then validated against it.
 *
 * The point the page is making is `validate()`'s collecting mode: every fault in one pass. A
 * fail-fast read stops at the first, which for an LLM retry loop means one round trip per error.
 */
import { validate } from '@ltr8/tson';
import { standardLibrary } from '@ltr8/tson/stdlib';
import { SCENARIOS, SCHEMA } from './scenarios.js';

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();

/**
 * `resolveSchema` registers a schema under its own `!!id`, so re-resolving the same text needs a
 * fresh registry rather than the same one twice. Cached by text, so an edit to the *document* never
 * recompiles the schema -- which is why the first keystroke costs ~50 ms and the rest cost ~1 ms.
 */
let compiled = null;
let compiledFor = null;

function compileSchema(text) {
  if (compiledFor === text) return { compiled, error: null };
  try {
    const fresh = standardLibrary();
    const linked = fresh.resolveSchema(text);
    compiled = fresh.compile(linked);
    compiledFor = text;
    return { compiled, error: null };
  } catch (error) {
    compiled = null;
    compiledFor = null;
    return { compiled: null, error };
  }
}

/**
 * A library gap is not a verdict on the document, so it is styled and worded differently -- the
 * diagnostic vocabulary keeps them apart precisely so a consumer can.
 */
const isGap = (code) => code === 'NOT_IMPLEMENTED';

function positionLabel(diagnostic) {
  const p = diagnostic.dataPosition;
  return p ? `${p.line}:${p.column}` : '—';
}

function renderGutter(text, lines) {
  const bad = new Set(lines);
  // A document ending in a newline has a trailing empty line that editors do not number.
  const lineCount = text.split('\n').length;
  const count = text.endsWith('\n') ? lineCount - 1 : lineCount;
  const rows = [];
  for (let n = 1; n <= count; n++) {
    rows.push(bad.has(n) ? `<span class="bad">${n}</span>` : String(n));
  }
  return rows.join('\n');
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function renderDiagnostics(diagnostics) {
  const list = $('diags');
  if (diagnostics.length === 0) {
    list.innerHTML = '<li class="empty">Nothing to report — the document conforms.</li>';
    return;
  }
  list.innerHTML = diagnostics
    .map((d, i) => {
      const detail = [];
      if (d.path) detail.push(`<span><span class="k">at</span> ${escapeHtml(d.path)}</span>`);
      if (d.expected)
        detail.push(`<span><span class="k">expected</span> ${escapeHtml(d.expected)}</span>`);
      if (d.actual)
        detail.push(`<span><span class="k">found</span> ${escapeHtml(d.actual)}</span>`);
      return `<li><button type="button" data-i="${i}">
        <span class="diag-top">
          <span class="code${isGap(d.code) ? ' gap' : ''}">${escapeHtml(d.code)}</span>
          <span class="at">${positionLabel(d)}</span>
        </span>
        <span class="msg">${escapeHtml(d.message)}</span>
        ${detail.length ? `<span class="detail">${detail.join('')}</span>` : ''}
      </button></li>`;
    })
    .join('');

  // Clicking a diagnostic puts the caret on the offending byte. `offset` is a UTF-8 byte offset
  // and a textarea selection is in UTF-16 units, so it is converted rather than used directly.
  const data = $('data');
  for (const button of list.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      const d = diagnostics[Number(button.dataset.i)];
      if (!d.dataPosition) return;
      const index = utf16IndexOfByteOffset(data.value, d.dataPosition.offset);
      data.focus();
      data.setSelectionRange(index, Math.min(index + 1, data.value.length));
    });
  }
}

/** A byte offset into the UTF-8 encoding of `text`, as an index into the JS string. */
function utf16IndexOfByteOffset(text, byteOffset) {
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    if (bytes >= byteOffset) return i;
    const cp = text.codePointAt(i);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp >= 0x10000 ? 2 : 1;
  }
  return text.length;
}

function setVerdict(kind, label, count, timing) {
  const el = $('verdict');
  el.className = `verdict ${kind}`;
  el.innerHTML =
    `<span class="dot"></span><span><span class="count">${count}</span> ${escapeHtml(label)}</span>` +
    (timing ? `<span class="timing">${timing}</span>` : '');
}

function run() {
  const schemaText = $('schema').value;
  const dataText = $('data').value;
  const root = $('root').value.trim();
  const bytes = encoder.encode(dataText);

  const started = performance.now();
  let diagnostics;

  if (root === '') {
    // Class 1: base syntax and the built-in type vocabulary, no schema in scope.
    diagnostics = validate(bytes).diagnostics;
  } else {
    const { compiled: schema, error } = compileSchema(schemaText);
    if (error) {
      setVerdict('warn', 'the schema itself did not compile', 1, '');
      $('diags').innerHTML =
        `<li><button type="button"><span class="diag-top"><span class="code gap">SCHEMA_ERROR</span></span>` +
        `<span class="msg">${escapeHtml(error.message)}</span></button></li>`;
      $('gutter').textContent = renderGutter(dataText, []);
      return;
    }
    diagnostics = validate(bytes, { schema, root }).diagnostics;
  }
  const elapsed = performance.now() - started;

  const [verdict, label] =
    diagnostics.length === 0
      ? ['ok', 'diagnostics — the document conforms']
      : diagnostics.every((d) => isGap(d.code))
        ? ['warn', 'library gaps — nothing was checked']
        : [
            'bad',
            diagnostics.length === 1 ? 'diagnostic, in one pass' : 'diagnostics, in one pass',
          ];

  setVerdict(verdict, label, diagnostics.length, `${elapsed.toFixed(1)} ms`);
  renderDiagnostics(diagnostics);
  $('gutter').innerHTML = renderGutter(
    dataText,
    diagnostics.map((d) => d.dataPosition?.line).filter(Boolean),
  );
}

function loadScenario(scenario) {
  $('data').value = scenario.data;
  $('root').value = scenario.root;
  for (const chip of document.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.id === scenario.id));
  }
  run();
}

function init() {
  $('schema').value = SCHEMA;

  const chips = $('scenarios');
  for (const scenario of SCENARIOS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.id = scenario.id;
    chip.textContent = scenario.label;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => loadScenario(scenario));
    chips.append(chip);
  }

  let timer;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  };
  $('data').addEventListener('input', debounced);
  $('schema').addEventListener('input', debounced);
  $('root').addEventListener('input', debounced);

  loadScenario(SCENARIOS[1]);
  document.body.dataset.ready = 'true';
}

init();
