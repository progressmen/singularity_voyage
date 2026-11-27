/**
 * 技能（Skill）管理服务。
 *
 * 列表来自 `ctx.skills`（含内置 / 插件 / 项目 / 用户目录），
 * 启用与停用通过改写 SKILL.md 的 frontmatter 生效：
 *   - `disable-model-invocation: true`：模型技能目录不再出现；
 *   - `user-invocable: false`：`/` 斜杠菜单不再出现。
 * 新建写入项目 `.dsh/skills/<name>/SKILL.md`，删除只允许项目 / 用户技能目录内的文件。
 */
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { svError, svLog } from './log.ts'

/** 技能名：小写字母 / 数字 / 连字符（与 dsh 的 skill 名称规范一致）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 新建技能允许的最大指令正文长度。 */
const MAX_SKILL_CONTENT = 200_000
/** 新建技能允许的最大描述长度（模型目录会截断展示，但文件里保留原文）。 */
const MAX_SKILL_DESCRIPTION = 1_000

/** 技能来源 → 页面展示标签。 */
const SOURCE_LABELS: Record<string, string> = {
  'project-dsh': '项目 .dsh',
  'project-agents': '项目 .agents',
  custom: '自定义目录',
  'user-dsh': '用户 .dsh',
  'user-agents': '用户 .agents',
  bundled: '内置 / 插件',
}

interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source?: string
  readonly path?: string
  readonly provider?: string
  readonly invocation?: {
    readonly modelInvocable?: boolean
    readonly userInvocable?: boolean
  }
}

/** 宿主技能注册表的最小结构（不把 sv-app 绑死到具体版本）。 */
interface SkillRegistryLike {
  list(options?: { cwd?: string }): Promise<readonly SkillSummaryLike[]>
}

/** `/sv/api/skills` 返回的技能条目。 */
export interface SvSkillView {
  name: string
  description: string
  whenToUse?: string
  source: string
  sourceLabel: string
  provider: string
  path?: string
  /** 模型与用户两个入口都可用。 */
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  /** 本地文件位于可管理的技能目录（可启停 / 删除）。 */
  editable: boolean
}

/** 新建技能的输入。 */
export interface SvSkillCreateInput {
  name: string
  description: string
  whenToUse?: string
  content: string
}

/** 定位到的本地技能文件与删除目标。 */
interface EditableSkillPath {
  /** SKILL.md（或扁平 .md）的真实路径。 */
  file: string
  /** 目录型技能的目录路径；扁平文件时为 undefined。 */
  directory?: string
}

/** frontmatter 里的调用控制。 */
interface InvocationFlags {
  modelInvocable: boolean
  userInvocable: boolean
}

function isSkillName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && SKILL_NAME_RE.test(value)
}

/** YAML 布尔值解析（只处理技能 frontmatter 里常见的几种写法）。 */
function yamlBoolean(raw: string): boolean | undefined {
  const value = raw.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return undefined
}

/** frontmatter 的起止行号；没有合法 frontmatter 时返回 undefined。 */
function frontmatterRange(lines: readonly string[]): { start: number; end: number } | undefined {
  if (lines[0]?.trim() !== '---') return undefined
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') return { start: 0, end: index }
  }
  return undefined
}

/** 从文件文本里读取调用控制；无法解析时返回 undefined。 */
function readInvocationFlags(text: string): InvocationFlags | undefined {
  const lines = text.split(/\r?\n/)
  const range = frontmatterRange(lines)
  if (range === undefined) return undefined
  let disableModel: boolean | undefined
  let userInvocable: boolean | undefined
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index] ?? ''
    const match = /^(disable-model-invocation|user-invocable)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = yamlBoolean(match[2] ?? '')
    if (match[1] === 'disable-model-invocation') disableModel = value
    else userInvocable = value
  }
  return { modelInvocable: disableModel !== true, userInvocable: userInvocable !== false }
}

/** 改写 frontmatter 的调用控制，保留其余字段与正文。 */
function setInvocationFlags(text: string, enabled: boolean): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const range = frontmatterRange(lines)
  if (range === undefined) throw new Error('技能文件缺少合法的 YAML frontmatter')
  const kept = lines.slice(range.start + 1, range.end).filter(line => (
    !/^disable-model-invocation\s*:/.test(line) && !/^user-invocable\s*:/.test(line)
  ))
  if (!enabled) kept.push('disable-model-invocation: true', 'user-invocable: false')
  const next = [lines[0] ?? '---', ...kept, lines[range.end] ?? '---', ...lines.slice(range.end + 1)]
  return next.join(eol)
}

/** 生成新建技能的 SKILL.md 内容。 */
function buildSkillFile(input: SvSkillCreateInput): string {
  const lines = [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
  ]
  if (input.whenToUse !== undefined && input.whenToUse.length > 0) {
    lines.push(`whenToUse: ${JSON.stringify(input.whenToUse)}`)
  }
  lines.push('---', '', input.content.trim(), '')
  return lines.join('\n')
}

/**
 * 技能管理服务：读宿主注册表，写本地技能文件。
 */
export class SkillManager {
  constructor(
    private readonly ctx: Context,
    private readonly cwd: string,
  ) {}

  /** 全部技能（含内置 / 插件 / 已停用），按名称排序。 */
  async list(): Promise<SvSkillView[]> {
    const skills = await this.summaries()
    const views = await Promise.all(skills.map(skill => this.view(skill)))
    return views.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** 新建一个项目级技能；同名已存在时拒绝。 */
  async create(input: SvSkillCreateInput): Promise<SvSkillView> {
    const name = input.name.trim()
    if (!isSkillName(name)) throw new Error('技能名只能包含小写字母、数字与连字符（如 weekly-report）')
    const description = input.description.trim()
    if (description.length === 0) throw new Error('技能描述不能为空')
    if (description.length > MAX_SKILL_DESCRIPTION) throw new Error(`技能描述最多 ${MAX_SKILL_DESCRIPTION} 字`)
    const whenToUse = input.whenToUse?.trim()
    if (whenToUse !== undefined && whenToUse.length > 2_000) throw new Error('「何时使用」最多 2000 字')
    const content = input.content.trim()
    if (content.length === 0) throw new Error('技能指令正文不能为空')
    if (content.length > MAX_SKILL_CONTENT) throw new Error('技能指令正文过长')
    if ((await this.list()).some(skill => skill.name === name)) throw new Error(`已存在同名技能「${name}」`)

    const root = join(this.cwd, '.dsh', 'skills')
    const directory = join(root, name)
    const file = join(directory, 'SKILL.md')
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(file, buildSkillFile({ name, description, ...(whenToUse === undefined ? {} : { whenToUse }), content }), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST') {
        throw new Error(`技能目录里已存在 SKILL.md：${file}`)
      }
      throw error
    }
    this.ctx.logger.info(svLog('skill', 'skill_created', { name, file }))
    return {
      name,
      description,
      ...(whenToUse === undefined || whenToUse.length === 0 ? {} : { whenToUse }),
      source: 'project-dsh',
      sourceLabel: SOURCE_LABELS['project-dsh']!,
      provider: 'filesystem',
      path: file,
      enabled: true,
      modelInvocable: true,
      userInvocable: true,
      editable: true,
    }
  }

  /** 启用 / 停用：同时控制模型调用与 `/` 菜单。 */
  async setEnabled(name: string, enabled: boolean): Promise<SvSkillView> {
    const skill = await this.find(name)
    if (skill.path === undefined) throw new Error('该技能没有本地文件，暂不支持在页面启停')
    const target = await this.editablePath(skill.path)
    if (target === undefined) throw new Error('内置或插件技能为只读，不能在此启停')
    const text = await readFile(target.file, 'utf8')
    await writeFile(target.file, setInvocationFlags(text, enabled), 'utf8')
    this.ctx.logger.info(svLog('skill', enabled ? 'skill_enabled' : 'skill_disabled', { name, file: target.file }))
    return this.view(skill)
  }

  /** 删除本地技能文件；目录型技能会连同同目录资源一起删除。 */
  async remove(name: string): Promise<void> {
    const skill = await this.find(name)
    if (skill.path === undefined) throw new Error('该技能没有本地文件，暂不支持删除')
    const target = await this.editablePath(skill.path)
    if (target === undefined) throw new Error('内置或插件技能为只读，不能删除')
    if (target.directory !== undefined) await rm(target.directory, { recursive: true })
    else await rm(target.file)
    this.ctx.logger.info(svLog('skill', 'skill_deleted', { name, path: skill.path }))
  }

  private registry(): SkillRegistryLike | undefined {
    const registry = this.ctx.get('skills') as SkillRegistryLike | undefined
    return registry !== undefined && typeof registry.list === 'function' ? registry : undefined
  }

  /** 宿主注册表的原始摘要（含 path / invocation），供管理写操作定位文件。 */
  private async summaries(): Promise<readonly SkillSummaryLike[]> {
    const registry = this.registry()
    if (registry === undefined) return []
    try {
      return await registry.list({ cwd: this.cwd })
    } catch (error) {
      this.ctx.logger.warn(svLog('skill', 'list_failed', { err: svError(error) }))
      return []
    }
  }

  private async find(name: string): Promise<SkillSummaryLike> {
    const match = (await this.summaries()).find(skill => skill.name === name)
    if (match === undefined) throw new Error(`技能「${name}」不存在`)
    return match
  }

  private async view(skill: SkillSummaryLike): Promise<SvSkillView> {
    const invocation = skill.invocation ?? {}
    let modelInvocable = invocation.modelInvocable !== false
    let userInvocable = invocation.userInvocable !== false
    const editable = skill.path === undefined ? undefined : await this.editablePath(skill.path)
    if (editable !== undefined) {
      // 以文件为准，刚改完 frontmatter 时不必等文件监听刷新注册表
      const flags = await readFile(editable.file, 'utf8').then(readInvocationFlags).catch(() => undefined)
      if (flags !== undefined) {
        modelInvocable = flags.modelInvocable
        userInvocable = flags.userInvocable
      }
    }
    const source = skill.source ?? 'unknown'
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      source,
      sourceLabel: SOURCE_LABELS[source] ?? source,
      provider: skill.provider ?? 'unknown',
      ...(skill.path === undefined ? {} : { path: skill.path }),
      enabled: modelInvocable && userInvocable,
      modelInvocable,
      userInvocable,
      editable: editable !== undefined,
    }
  }

  /** 可管理的技能目录：项目 / 用户的 .dsh 与 .agents 技能根。 */
  private editableRoots(): string[] {
    const dshHome = process.env.DSH_HOME?.trim()
    const agentsHome = process.env.DSH_AGENTS_HOME?.trim()
    const roots = [
      join(this.cwd, '.dsh', 'skills'),
      join(this.cwd, '.agents', 'skills'),
      join(dshHome === undefined || dshHome.length === 0 ? join(homedir(), '.dsh') : dshHome, 'skills'),
      join(agentsHome === undefined || agentsHome.length === 0 ? join(homedir(), '.agents') : agentsHome, 'skills'),
    ].map(root => resolve(root))
    return [...new Set(roots)]
  }

  private async editablePath(path: string): Promise<EditableSkillPath | undefined> {
    let realFile: string
    try {
      realFile = await realpath(path)
    } catch {
      return undefined
    }
    const roots = await Promise.all(this.editableRoots().map(async root => {
      try {
        return await realpath(root)
      } catch {
        return root
      }
    }))
    for (const root of roots) {
      const rel = relative(root, realFile)
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue
      const segments = rel.split(sep)
      if (segments.length === 1 && segments[0]!.endsWith('.md')) return { file: realFile }
      if (segments.length === 2 && segments[1] === 'SKILL.md') return { file: realFile, directory: dirname(realFile) }
    }
    return undefined
  }
}
