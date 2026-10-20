// Bump the plugin version everywhere and create a release commit + tag.
//   npm run release -- 0.1.1 [minAppVersion]
// Then: git push --follow-tags  (CI builds and publishes the GitHub release)
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [version, minAppArg] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: npm run release -- <x.y.z> [minAppVersion]')
  process.exit(1)
}
const sh = cmd => execSync(cmd, { stdio: 'inherit' })
if (execSync('git status --porcelain').toString().trim()) {
  console.error('working tree not clean — commit or stash first')
  process.exit(1)
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, d) => writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`)

const manifest = readJson('manifest.json')
const minApp = minAppArg ?? manifest.minAppVersion
manifest.version = version
manifest.minAppVersion = minApp
writeJson('manifest.json', manifest)

const versions = readJson('versions.json')
versions[version] = minApp
writeJson('versions.json', versions)

const pkg = readJson('package.json')
pkg.version = version
writeJson('package.json', pkg)

sh('npm install --package-lock-only --silent')
sh('npm run lint')
sh('npm test')
sh('npm run build')
sh('git add manifest.json versions.json package.json package-lock.json')
sh(`git commit -m "release: ${version}"`)
sh(`git tag ${version}`)
console.log(`\nTagged ${version}. Publish with: git push --follow-tags`)
