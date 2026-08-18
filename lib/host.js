/**
 * dsh-config-export — host half.
 *
 * Owns the export/import engine: scans ~/.dsh into selectable sections,
 * packs tar.gz backups into ~/.dsh/exports/, optionally sanitizes plaintext
 * secrets (SSH passwords), and restores from a backup with an automatic
 * safety snapshot beforehand. Exposes loopback-only HTTP routes for the
 * browser panel. Failure policy: log and return structured errors, never
 * crash the host.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync, readdirSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

const run = promisify(execFile)

const DSH_HOME = join(homedir(), '.dsh')
const EXPORT_DIR = join(DSH_HOME, 'exports')
const SAFETY_DIR = join(DSH_HOME, 'exports', 'safety')
const MAX_IMPORT_BYTES = 256 * 1024 * 1024

/** Selectable export sections. `paths` are relative to ~/.dsh. */
const SECTIONS = [
  {
    id: 'settings',
    label: '全局设置',
    desc: 'settings.yaml',
    paths: ['settings.yaml'],
    optional: false,
  },
  {
    id: 'profiles',
    label: 'Profile 与插件列表',
    desc: 'profiles/（含各 profile 插件配置，不含 node_modules 与锁文件缓存）',
    paths: ['profiles'],
    excludes: ['node_modules', '*/node_modules', '*.log', '.pnpm-store'],
    optional: false,
  },
  {
    id: 'ssh',
    label: 'SSH 主机配置',
    desc: 'dsh-ssh.json（含主机/密钥/密码，可脱敏）',
    paths: ['dsh-ssh.json'],
    optional: true,
    sensitive: true,
  },
  {
    id: 'presets',
    label: 'Agent 预设（梁神模式等）',
    desc: '.agent-presets/',
    paths: ['.agent-presets'],
    optional: true,
  },
  {
    id: 'skin',
    label: '皮肤与外观',
    desc: 'skin-center/、pet.json',
    paths: ['skin-center', 'pet.json'],
    optional: true,
  },
  {
    id: 'taskboard',
    label: '任务看板',
    desc: 'task-board/',
    paths: ['task-board'],
    optional: true,
  },
  {
    id: 'usage',
    label: '额度统计',
    desc: 'deepseek-usage/',
    paths: ['deepseek-usage'],
    optional: true,
  },
]

/** Extra dirs the import restorer is allowed to touch (top-level names). */
const RESTORABLE_TOPS = new Set([
  'settings.yaml', 'profiles', 'dsh-ssh.json', '.agent-presets',
  'skin-center', 'pet.json', 'task-board', 'deepseek-usage',
])

function sectionByPath(topName) {
  for (const section of SECTIONS) {
    for (const p of section.paths) {
      if (p === topName) return section
    }
  }
  return null
}
const sectionOf = sectionByPath

function fmtSize(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function listTar(input) {
  const args = ['-tzf', input]
  return run('tar', args, { maxBuffer: 64 * 1024 * 1024 }).then(r => r.stdout.split('\n').map(s => s.trim()).filter(Boolean))
}

function pack(output, cwd, paths, excludes) {
  const args = ['-czf', output]
  for (const ex of excludes ?? []) args.push(`--exclude=${ex}`)
  args.push('--', ...paths)
  return run('tar', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
}

export class ConfigExportHost {
  constructor(ctx) {
    this.ctx = ctx
    this.logger = ctx.logger
  }

  ensureDirs() {
    mkdirSync(EXPORT_DIR, { recursive: true })
  }

  /** Snapshot for the panel: sections with presence/size, existing exports. */
  state() {
    const sections = SECTIONS.map(section => {
      let present = false
      let size = 0
      for (const p of section.paths) {
        const full = join(DSH_HOME, p)
        if (!existsSync(full)) continue
        present = true
        const st = statSync(full)
        if (st.isFile()) size += st.size
        else {
          try {
            for (const entry of readdirSync(join(DSH_HOME, p, 'node_modules'), { recursive: false })) void entry
          } catch { /* not a dir with node_modules */ }
          size += this.dirSize(full)
        }
      }
      return {
        id: section.id,
        label: section.label,
        desc: section.desc,
        optional: section.optional,
        sensitive: Boolean(section.sensitive),
        present,
        size: fmtSize(size),
        sizeBytes: size,
      }
    })
    const exports = this.listExports()
    return { dshHome: DSH_HOME, exportDir: EXPORT_DIR, sections, exports }
  }

  dirSize(dir, depth = 0) {
    if (depth > 4) return 0
    let total = 0
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) total += this.dirSize(full, depth + 1)
        else total += statSync(full).size
      } catch { /* unreadable entry */ }
    }
    return total
  }

  listExports() {
    this.ensureDirs()
    const out = []
    for (const name of readdirSync(EXPORT_DIR)) {
      if (!name.endsWith('.tar.gz')) continue
      const full = join(EXPORT_DIR, name)
      try {
        const st = statSync(full)
        out.push({ name, size: st.size, sizeText: fmtSize(st.size), at: st.mtimeMs })
      } catch { /* raced */ }
    }
    out.sort((a, b) => b.at - a.at)
    return out.slice(0, 50)
  }

  /** Strip plaintext passwords from a JSON buffer (password/passphrase/token/secret keys); returns sanitized text or null. */
  sanitizeJson(text) {
    try {
      const data = JSON.parse(text)
      let redacted = 0
      const walk = node => {
        if (Array.isArray(node)) { for (const item of node) walk(item); return }
        if (node && typeof node === 'object') {
          for (const key of Object.keys(node)) {
            if (/passphrase|password|secret|token/i.test(key) && typeof node[key] === 'string' && node[key] !== '') {
              node[key] = '__REDACTED__'
              redacted += 1
            } else {
              walk(node[key])
            }
          }
        }
      }
      walk(data)
      return { text: JSON.stringify(data, null, 2), redacted }
    } catch {
      return null
    }
  }

  /**
   * Export selected sections into one timestamped tar.gz.
   * When sanitize is set, sensitive files (dsh-ssh.json) are rewritten with
   * password-like fields replaced by __REDACTED__ before packing.
   */
  async doExport(sectionIds, sanitize) {
    this.ensureDirs()
    const chosen = SECTIONS.filter(s => sectionIds.includes(s.id) && this.sectionPresent(s))
    if (chosen.length === 0) throw new Error('未选择任何存在的配置项')

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const output = join(EXPORT_DIR, `dsh-config-${stamp}.tar.gz`)
    const staging = join(EXPORT_DIR, `.staging-${stamp}`)
    mkdirSync(staging, { recursive: true })
    let redactedTotal = 0
    try {
      const paths = []
      for (const section of chosen) {
        for (const p of section.paths) {
          const full = join(DSH_HOME, p)
          if (!existsSync(full)) continue
          paths.push(p)
        }
      }
      if (paths.length === 0) throw new Error('所选配置项当前都不存在')
      const excludes = chosen.flatMap(s => s.excludes ?? [])
      // Copy everything into staging (sanitized files shadow their originals),
      // then pack once from there — GNU tar cannot append to compressed archives.
      for (const p of paths) {
        const src = join(DSH_HOME, p)
        const dst = join(staging, p)
        if (sanitize && sectionOf(p)?.sensitive && statSync(src).isFile()) {
          const result = this.sanitizeJson(readFileSync(src, 'utf8'))
          if (result) {
            writeFileSync(dst, result.text)
            redactedTotal += result.redacted
            continue
          }
        }
        await run('cp', ['-a', '--', src, dst])
      }
      await pack(output, staging, paths, excludes)
      const size = statSync(output).size
      this.logger.info(`config-export: wrote ${output} (${fmtSize(size)})`)
      return { file: output, name: output.split('/').pop(), size, sizeText: fmtSize(size), redacted: redactedTotal, sections: chosen.map(s => s.id) }
    } finally {
      try { run('rm', ['-rf', staging]) } catch { /* best effort */ }
    }
  }

  sectionPresent(section) {
    return section.paths.some(p => existsSync(join(DSH_HOME, p)))
  }

  deleteExport(name) {
    if (!/^[\w.-]+\.tar\.gz$/.test(name)) throw new Error('非法文件名')
    const full = join(EXPORT_DIR, name)
    if (!existsSync(full)) throw new Error('文件不存在')
    unlinkSync(full)
    return { ok: true }
  }

  /** Peek into a backup: list section coverage without extracting. */
  async preview(name) {
    if (!/^[\w.-]+\.tar\.gz$/.test(name)) throw new Error('非法文件名')
    const full = join(EXPORT_DIR, name)
    if (!existsSync(full)) throw new Error('文件不存在')
    const entries = await listTar(full)
    const found = new Set()
    for (const entry of entries) {
      const top = entry.replace(/^\.\//, '').split('/')[0]
      const section = sectionByPath(top)
      if (section) found.add(section.label)
    }
    return { name, entries: entries.length, sections: [...found] }
  }

  /**
   * Import (restore) a backup. Safety first: snapshot the current restorable
   * config into safety/, then replace the chosen top-level names.
   * `buffer` is the uploaded tar.gz (falls back to a named file in exports/).
   */
  async doImport({ buffer, name, sectionIds }) {
    this.ensureDirs()
    let file = null
    if (buffer != null) {
      if (buffer.length > MAX_IMPORT_BYTES) throw new Error('备份包过大')
      if (!/^[\w.-]+\.tar\.gz$/.test(name ?? '')) {
        name = `upload-${Date.now()}.tar.gz`
      }
      file = join(EXPORT_DIR, name)
      writeFileSync(file, buffer)
    } else {
      if (!/^[\w.-]+\.tar\.gz$/.test(name ?? '')) throw new Error('非法文件名')
      file = join(EXPORT_DIR, name)
      if (!existsSync(file)) throw new Error('备份不存在')
    }

    // What top-level names does the archive actually contain?
    const entries = await listTar(file)
    const tops = new Set(entries.map(e => e.replace(/^\.\//, '').split('/')[0]))
    let targets = [...tops].filter(t => RESTORABLE_TOPS.has(t))
    if (sectionIds && sectionIds.length > 0) {
      const wanted = new Set()
      for (const section of SECTIONS) {
        if (sectionIds.includes(section.id)) for (const p of section.paths) wanted.add(p)
      }
      targets = targets.filter(t => wanted.has(t))
    }
    if (targets.length === 0) throw new Error('备份中没有可恢复的配置项')

    // Guard: a sanitized backup contains __REDACTED__ secrets. Restoring it
    // over the live config would silently destroy passwords/passphrases.
    if (targets.includes('dsh-ssh.json')) {
      const tmpScan = join(EXPORT_DIR, `.scan-${Date.now()}`)
      mkdirSync(tmpScan, { recursive: true })
      try {
        await run('tar', ['-xzf', file, '-C', tmpScan, '--', 'dsh-ssh.json'], { maxBuffer: 16 * 1024 * 1024 })
        const text = readFileSync(join(tmpScan, 'dsh-ssh.json'), 'utf8')
        if (text.includes('__REDACTED__')) {
          throw new Error('该备份的敏感字段已脱敏（__REDACTED__），直接恢复会丢失密码。请改用未脱敏的备份，或手动补齐密码后再导入。')
        }
      } finally {
        await run('rm', ['-rf', tmpScan]).catch(() => {})
      }
    }

    // 1. Safety snapshot of everything we are about to touch.
    mkdirSync(SAFETY_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const safetyFile = join(SAFETY_DIR, `pre-import-${stamp}.tar.gz`)
    const present = targets.filter(t => existsSync(join(DSH_HOME, t)))
    if (present.length > 0) {
      await pack(safetyFile, DSH_HOME, present)
    }

    // 2. Extract selected tops. permissive: archive may not be prefixed ./
    const tmp = join(EXPORT_DIR, `.import-${stamp}`)
    mkdirSync(tmp, { recursive: true })
    try {
      await run('tar', ['-xzf', file, '-C', tmp, '--', ...targets], { maxBuffer: 16 * 1024 * 1024 })
      for (const top of targets) {
        const src = join(tmp, top)
        if (!existsSync(src)) continue
        const dst = join(DSH_HOME, top)
        await run('rm', ['-rf', dst])
        await run('mv', [src, dst])
      }
    } finally {
      await run('rm', ['-rf', tmp]).catch(() => {})
    }
    this.logger.info(`config-export: restored ${targets.join(', ')} from ${file} (safety: ${safetyFile})`)
    return {
      ok: true,
      restored: targets,
      safety: safetyFile,
      note: '插件依赖需重启 dsh web 后执行 dsh plugin --profile <p> install 生效',
    }
  }
}
