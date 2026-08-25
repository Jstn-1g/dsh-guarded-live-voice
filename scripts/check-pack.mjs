import { execFileSync } from 'node:child_process'

const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm pack --dry-run --ignore-scripts --json']
  : ['pack', '--dry-run', '--ignore-scripts', '--json']
const output = execFileSync(executable, args, {
  encoding: 'utf8',
})
const [report] = JSON.parse(output)
const names = new Set(report.files.map(file => file.path))
const required = [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'package.json',
]
const missing = required.filter(name => !names.has(name))
if (missing.length > 0) {
  throw new Error(`packed artifact is missing: ${missing.join(', ')}`)
}
const forbidden = [...names].filter(name => name.startsWith('tests/') || name.startsWith('src/') || name === '.env')
if (forbidden.length > 0) {
  throw new Error(`packed artifact includes forbidden files: ${forbidden.join(', ')}`)
}
process.stdout.write(`pack check passed (${report.files.length} files, ${report.unpackedSize} bytes)\n`)
