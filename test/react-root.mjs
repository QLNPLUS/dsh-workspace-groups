/**
 * Where the two renderer-based tests get React from.
 *
 * `host.mjs` and `smoke.mjs` need nothing but Node; `render.mjs` and `mount.mjs`
 * need the real React reconciler, because a hand-written hook runtime cannot
 * prove that React's own rules accept the tree. React is not a dependency of
 * this plugin (the DSH page supplies it through the module loader), so the
 * tests discover an installed copy instead of shipping one.
 *
 * Discovery order, first hit wins:
 *   1. `WG_REACT_ROOT` — an absolute path to a directory whose `node_modules`
 *      holds React. This is how CI or a `pnpm add` scratch dir points at it.
 *   2. `node_modules` beside the package (what a `pnpm add -D react react-dom`
 *      inside this directory produces).
 *   3. the workspace's own `node_modules`.
 *
 * The tests SKIP with a clear message rather than fail when React is absent:
 * "the tool is not installed" is not "the plugin is broken".
 *
 * @module dsh-workspace-groups/test/react-root
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

/** Absolute roots to probe, in order. */
const candidates = [
  process.env.WG_REACT_ROOT,
  packageRoot,
  join(packageRoot, '..'),
].filter(candidate => typeof candidate === 'string' && candidate.length > 0)

/**
 * Find a require() that resolves React, with jsdom when asked.
 * @param options - `jsdom: true` additionally requires jsdom to resolve.
 * @returns `{ require, root }`, or `null` when no candidate can supply it.
 */
export function findReact(options = {}) {
  for (const root of candidates) {
    const entry = join(root, 'node_modules', 'react', 'package.json')
    if (!existsSync(entry)) continue
    const require = createRequire(join(root, 'noop.mjs'))
    if (!require.resolve('react')) continue
    if (options.jsdom === true) {
      try {
        require.resolve('jsdom')
      } catch {
        continue
      }
    }
    return { require, root }
  }
  return null
}

/** React's own version, so a skip message can say what was found. */
export function reactVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'react', 'package.json'), 'utf8'))
    return pkg.version
  } catch {
    return 'unknown'
  }
}

/**
 * Print the skip notice and exit 0.
 * @param what - the file that could not run.
 * @param needs - what must be installed.
 */
export function skip(what, needs) {
  console.log(`▸ SKIP — ${what} needs ${needs}, which is not installed beside the package.`)
  console.log('')
  console.log('  The two Node-only suites still run:')
  console.log('    node test/host.mjs && node test/smoke.mjs')
  console.log('')
  console.log('  To enable this one:')
  console.log('    cd workspace-groups && pnpm add -D react@18 react-dom@18 jsdom')
  console.log('  or point WG_REACT_ROOT at a directory whose node_modules has them.')
  process.exit(0)
}
