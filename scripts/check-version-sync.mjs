import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(scriptDir, '..', 'desktop-ui')
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
const tauriConfig = JSON.parse(fs.readFileSync(path.join(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const cargoToml = fs.readFileSync(path.join(desktopDir, 'src-tauri', 'Cargo.toml'), 'utf8')
const cargoVersion = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]

const versions = {
  'desktop-ui/package.json': packageJson.version,
  'desktop-ui/src-tauri/tauri.conf.json': tauriConfig.version,
  'desktop-ui/src-tauri/Cargo.toml': cargoVersion,
}
const uniqueVersions = new Set(Object.values(versions))

if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
  console.error('记忆面包版本号不一致：')
  for (const [file, version] of Object.entries(versions)) {
    console.error(`- ${file}: ${version ?? '未找到'}`)
  }
  process.exit(1)
}

console.log(`记忆面包版本号已同步：${packageJson.version}`)
