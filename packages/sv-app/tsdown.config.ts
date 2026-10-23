import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  // 所有 dsh/cordis 包保持外部引用：运行时必须与宿主使用同一份实例。
  // pg 由 node_modules 运行时解析（含可选原生依赖，打包会破坏其动态加载）。
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^pg(\/|$)/],
  },
})
