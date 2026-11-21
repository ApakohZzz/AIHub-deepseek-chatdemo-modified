import { execFileSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const output = path.resolve(root, 'dist')
if (path.dirname(output) !== root || path.basename(output) !== 'dist')
  throw new Error('Invalid build directory')
await rm(output, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [path.join(root, 'node_modules/@rspack/cli/bin/rspack.js'), 'build', '-c', 'rspack.config.ts'],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  }
)
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const commit =
  process.env.AIHUB_COMMIT ||
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
await writeFile(
  path.join(output, 'version.json'),
  JSON.stringify({ name: 'AI Hub', version, commit }, null, 2) + '\n'
)
