// Preflight: fail LOUDLY and actionably when run under the wrong Node.
//
// This box has two Nodes: the Hermes-bundled one (~/.local/bin/node, first in
// PATH, currently v26) and nvm's v20, which better-sqlite3 is compiled against.
// `engines: ">=20"` accepts both, so nothing warned — the process just died
// mid-job with a NODE_MODULE_VERSION mismatch (recurring incident, last on
// 2026-09-26 during the §8.5 graduation run). This check runs as a pre-hook on
// every entry-point npm script and turns that crash into a clear instruction.

const EXPECTED_MAJOR = 20

const major = Number(process.versions.node.split('.')[0])
if (major !== EXPECTED_MAJOR) {
  console.error(
    `\nWRONG NODE: this shell is running Node ${process.version}, but this project ` +
      `requires Node ${EXPECTED_MAJOR} (see .nvmrc — better-sqlite3 is compiled against it).\n` +
      `Fix:  source ~/.nvm/nvm.sh && nvm use ${EXPECTED_MAJOR}\n` +
      `(The Hermes-bundled node at ~/.local/bin/node shadows nvm in bare shells.)\n`,
  )
  process.exit(1)
}

// Version can be right while the compiled binding is stale (e.g. someone ran
// `npm rebuild` under the wrong Node). Prove the binding actually loads.
try {
  const require_ = (await import('node:module')).createRequire(import.meta.url)
  require_('better-sqlite3')
} catch (err) {
  console.error(
    `\nBROKEN NATIVE BINDING: Node ${process.version} is correct, but better-sqlite3 ` +
      `failed to load:\n  ${err.message.split('\n')[0]}\n` +
      `Fix:  source ~/.nvm/nvm.sh && nvm use ${EXPECTED_MAJOR} && npm rebuild better-sqlite3\n`,
  )
  process.exit(1)
}
