#!/usr/bin/env node
/**
 * 初始化 Singularity Voyage 的 dsh profile（默认 <repo>/.dsh/profiles/sv）。
 *
 * 做三件事：
 *  1. 写入 profile 清单（package.json，声明 dsh.profile 组合包与对本仓库 sv-app 的 link 依赖）；
 *  2. 在 profile 目录执行 pnpm install（把 sv-app 以 link: 方式挂进 profile node_modules）；
 *  3. 打印启动命令。
 *
 * DSH_HOME 默认指向仓库内 `.dsh/`，可用同名环境变量覆盖（便于与其它 dsh 实例隔离）。
 * 重复运行是安全的：manifest 会被重写为确定内容。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME ?? join(repoRoot, '.dsh')
const profileDir = join(dshHome, 'profiles', 'sv')
const svAppDir = join(repoRoot, 'packages', 'sv-app')

const manifest = {
  name: 'sv-profile',
  private: true,
  type: 'module',
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@singularity-voyage/sv-app',
      ],
    },
  },
  dependencies: {
    '@singularity-voyage/sv-app': `link:${svAppDir}`,
  },
}

await mkdir(profileDir, { recursive: true })
await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`[sv] profile 目录: ${profileDir}`)
console.log('[sv] 安装 profile 依赖 (pnpm install)…')
const install = spawnSync('pnpm', ['install', '--prefer-offline'], {
  cwd: profileDir,
  stdio: 'inherit',
})
if (install.status !== 0) {
  console.error('[sv] pnpm install 失败；请确认 pnpm 已安装且网络可用。')
  process.exit(install.status ?? 1)
}

const dshSrc = process.env.DSH_SRC ?? join(repoRoot, '..', 'deepseek-harness-dsh-v0.2.1-rc.2')
console.log('')
console.log('[sv] 就绪。启动（或直接 pnpm dev）：')
console.log(`      node "${join(dshSrc, 'apps', 'cli', 'lib', 'bin.js')}" --profile sv --port 7000 --no-open`)
console.log('')
console.log('[sv] Singularity Voyage 页面: http://127.0.0.1:7000/（自建前端，重定向到 /sv/）')
console.log('[sv] dsh 官方 Web UI 已禁用（web-runtime disabled），仅通过 /sv/api 桥接')
