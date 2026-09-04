// Shared loader for the CLI scripts.
//
// better-sqlite3 is a NATIVE module: it is compiled against one Node ABI and refuses to load under
// another. Two things make the raw failure unhelpful. It surfaces as an ERR_DLOPEN_FAILED wall of
// stack trace that never says what to do about it, and it is thrown LAZILY — the binding loads on
// `new Database(...)`, not on import — so guarding the import catches nothing. Hence a wrapped
// constructor rather than a wrapped import.

const NODE20 = `${process.env.HOME}/.nvm/versions/node/v20.20.2/bin`

/** True for both "binary built for another ABI" and "no binary for this ABI at all". */
function isAbiFailure(err) {
  return /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|dlopen|locate the bindings file/i.test(err.message)
}

function explainAndExit() {
  console.error(`
better-sqlite3 is compiled for a different Node version than the one running it.

  running:  ${process.version}  (${process.execPath})
  expected: Node 20             (see .nvmrc)

Node 26 is not an option here: better-sqlite3 11.x cannot compile against its V8 API and
publishes no prebuilt binary for it. Run this repo on Node 20:

  export PATH="${NODE20}:$PATH"

then re-run your command. (Add that line to ~/.zshrc to make it stick.)
`)
  process.exit(1)
}

/**
 * Returns a drop-in stand-in for better-sqlite3's constructor. Callable with `new`: returning an
 * object from a function called with `new` yields that object, so `new Database(...)` still gives a
 * real Database instance.
 */
export async function loadDatabase() {
  const Database = (await import('better-sqlite3')).default
  return function OpenDatabase(path, options) {
    try {
      return new Database(path, options)
    } catch (err) {
      if (isAbiFailure(err)) explainAndExit()
      throw err
    }
  }
}
