import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { zipSync } from 'fflate'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const collect = async (files, directory, prefix = '') => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await collect(files, path.join(directory, entry.name), name + '/')
    else files[name] = new Uint8Array(await readFile(path.join(directory, entry.name)))
  }
}
await mkdir(path.join(root, 'artifacts'), { recursive: true })
const writeBundle = async (variant, files) => {
  const archive = zipSync(files, { level: 6 })
  const name = `ai-hub-${variant}-v${version}.zip`
  const digest = createHash('sha256').update(archive).digest('hex')
  await writeFile(path.join(root, 'artifacts', name), archive)
  await writeFile(path.join(root, 'artifacts', name + '.sha256'), `${digest}  ${name}\n`)
  console.log(`${name}  ${archive.length} bytes  SHA256 ${digest}`)
}
const web = {}
await collect(web, path.join(root, 'dist'))
await writeBundle('web', web)
const server = Object.fromEntries(Object.entries(web).map(([name, data]) => ['dist/' + name, data]))
for (const file of [
  'config.mjs',
  'index.mjs',
  'oauth.mjs',
  'proxy.mjs',
  'vault.mjs',
  'workspace.mjs',
  'README.md',
  '.env.example',
]) {
  server['server/' + file] = await readFile(path.join(root, 'server', file))
}
await writeBundle('server', server)
