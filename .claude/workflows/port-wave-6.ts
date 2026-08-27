export const meta = {
  name: 'tson-port-wave-6',
  description:
    'Wave 6 of the TSON port: the public facades and front door, then the CLI built on top of them',
  whenToUse:
    'After Wave 5. Produces parse/readTree/validate/write, createTson, the schema sources, and the @ltr8/tson-cli commands.',
  phases: [
    { title: 'Facades', detail: 'the public API and the schema sources' },
    { title: 'CLI', detail: 'the command line tool, built on the facades' },
    { title: 'Review', detail: 'a security pass over the schema sources' },
  ],
};

// Genuinely sequential: the CLI is a consumer of the front door, and writing it against a guess
// at that API produces a CLI that has to be rewritten when the guess is wrong.

const FACADES = `Work package 19 (facades and front door). Produce packages/tson/src/index.ts's
real surface, packages/tson/src/config.ts and packages/tson/src/source/.

The public API is flat and tree-shakable first — parse, readTree, validate, write as plain
functions — with createTson(config) as a config-bound convenience over them, not as the primary
way in. Anyone who imports parse must not pay for the compiler.

Naming follows CLAUDE.md: bare types and functions (Schema, Config, ObjectReader, CompiledSchema,
DataParser), the Tson prefix only on errors.

Schema sources are the security-sensitive part of this whole port, because a schema is fetched by
URL at read time. Three requirements, none of them optional:

- HTTPS source: DENY BY DEFAULT. A host allow-list that is empty until configured. NO REDIRECTS
  EVER — not same-origin, not one hop; a redirect is how an allow-listed host becomes a request to
  somewhere else. A hard size cap, enforced while streaming rather than after, so a response that
  never ends cannot exhaust memory. A timeout.
- File source: containment checked AFTER realpath, never before. A symlink that resolves outside
  the permitted root is the entire attack, and a check on the pre-resolution path misses it.
- Neither source may be reachable by default from a browser build.

Read the Java's source handling, then read .references/ltr8-io-tson-java/CONFORMANCE.md on the
network atom parsers — it records where the reference is deliberately stricter than the JDK, and
the reasoning there applies to this layer too.

State clearly in the TSDoc what each source does and does not protect against.`;

const CLI = `Work package 20 (CLI). Produce packages/cli/src/ — the real @ltr8/tson-cli.

Four commands: validate, compile, hash, init-example. Three output formats: text, json, tson —
and tson output must be produced by this implementation's own writer, not by string concatenation.

Exit codes are part of the contract and scripts depend on them:
  0  valid
  1  invalid data
  2  usage error
  70 library fault

The distinction between 1 and 70 is the one that matters and the one most easily got wrong: 1
means the tool worked and the data was bad; 70 means the tool broke. An internal error reported as
1 tells a CI pipeline the data is invalid when in fact nothing was checked.

The current packages/cli/src/cli.ts is a placeholder that throws TsonNotImplementedError. Replace
it. Its --help text already describes the intended surface; keep it accurate.

Build on the facades from work package 19 — do not reach past them into the library's internals.
If something you need is not exposed, that is a finding about the facade, not a reason to bypass
it.`;

const PORT_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'status', 'filesWritten', 'specFindings', 'notes'],
  properties: {
    key: { type: 'string' },
    status: { enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    publicApi: {
      type: 'string',
      description: 'for 19: the exported surface, so the CLI need not guess at it',
    },
    specFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'issue', 'reading'],
        properties: {
          section: { type: 'string' },
          issue: { type: 'string' },
          reading: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const SECURITY = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'verdict'],
  properties: {
    verdict: { enum: ['sound', 'needs-work', 'unsafe'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'issue', 'severity', 'reproduction'],
        properties: {
          file: { type: 'string' },
          issue: { type: 'string' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          reproduction: {
            type: 'string',
            description: 'the concrete input or configuration that demonstrates it',
          },
        },
      },
    },
  },
};

const SHARED = `Read CLAUDE.md and ORCHESTRATION.md first. The contract layer is FROZEN. Waves 1
to 5 are done: the whole read stack, the resolver, the compiler and the writers all work.

Definition of done: npm run typecheck, npm run lint, npm run format:check, npm test,
npm run test:conformance, npm run build — and no conformance vector that was green may go red.`;

log('Wave 6: facades, then the CLI on top of them');

const facades = await agent(`${FACADES}\n\n${SHARED}`, {
  label: 'port:facades',
  phase: 'Facades',
  agentType: 'tson-porter',
  schema: PORT_RESULT,
  effort: 'high',
});

if (facades === null || facades.status === 'blocked') {
  log('Facades did not land; the CLI cannot be built on them');
  return { wave: 6, facades, cli: null, security: null };
}

const cli = await agent(
  `${CLI}

Work package 19 (the facades) has landed. Its author describes the public surface as:

${facades.publicApi ?? '(not stated — read packages/tson/src/index.ts directly)'}

Read the code where that description and the code differ.

${SHARED}`,
  { label: 'port:cli', phase: 'CLI', agentType: 'tson-porter', schema: PORT_RESULT },
);

// A dedicated adversarial pass, because this is the only layer that takes a URL from a
// configuration and fetches it. Everything else in this port operates on bytes someone already
// had. Getting it wrong here is an SSRF, not a failed parse.
const security = await agent(
  `Review the schema sources in packages/tson/src/source/ as an attacker, not as a reviewer.

Try specifically to:
1. Reach a host that is not on the allow-list. Redirects are the obvious route — confirm there is
   no redirect following at all, including a single same-origin hop, and including whatever the
   underlying fetch does by default rather than what the code appears to ask for.
2. Escape the file source's permitted root with a symlink. The check must happen after realpath;
   if it happens before, construct the symlink that proves it.
3. Exhaust memory or time: a response with no end, a response larger than the cap, a server that
   accepts and never replies. Confirm the size cap is enforced WHILE streaming, not after.
4. Reach either source from a browser build. Check the built bundle, not the imports.
5. Make the CLI exit 0 on invalid data, or exit 1 on an internal fault. Both mislead a script that
   trusts the exit code.

For each finding give the exact input or configuration that demonstrates it. A finding without a
reproduction is a guess, and guesses about security are worse than silence.`,
  { label: 'security', phase: 'Review', schema: SECURITY, effort: 'high' },
);

log(
  security === null
    ? 'Security review returned nothing'
    : `Security review: ${security.verdict}, ${String(security.findings.length)} findings`,
);

return { wave: 6, facades, cli, security };
