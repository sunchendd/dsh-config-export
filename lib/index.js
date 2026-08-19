/**
 * dsh-config-export — host loader entry.
 *
 * Registers loopback-only HTTP routes for the browser panel and injects a
 * short system-prompt section so the agent knows the plugin exists.
 */
import z from 'schemastery'
import { ConfigExportHost } from './host.js'

export const inject = ['webServer', 'systemPrompt']

export const Config = z.object({})

export const CONFIG_EXPORT_GUIDANCE = '本机已安装 dsh-config-export 插件（DSH 配置导出/导入）：侧边栏「配置备份」入口。可勾选 ~/.dsh 下各配置项（全局设置/插件 profile/SSH 主机/agent 预设/皮肤/看板等）一键打包 tar.gz 到 ~/.dsh/exports/，导出 SSH 配置时可选择脱敏密码字段；也可从备份包恢复（恢复前自动把现有配置快照到 exports/safety/，恢复插件后需重启 dsh web 并可执行 dsh plugin --profile <profile> install 重装依赖）。用户提到「导出配置 / 备份配置 / 导入配置 / 恢复配置 / 迁移 DSH」时即指本插件，请据此协作。'

export function apply(ctx) {
  const host = new ConfigExportHost(ctx)

  ctx.effect(() => {
    const routes = []
    const json = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const guard = (req, res) => {
      const socket = req.socket?.remoteAddress ?? ''
      const isLoopback = socket === '127.0.0.1' || socket === '::1' || socket === '::ffff:127.0.0.1'
      const site = req.headers['sec-fetch-site']
      if (!isLoopback || site === 'cross-site') {
        json(res, 403, { ok: false, error: 'forbidden' })
        return false
      }
      return true
    }
    const readBody = async (req, limit) => {
      const chunks = []
      let total = 0
      for await (const chunk of req) {
        total += chunk.length
        if (total > limit) throw new Error('too-large')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    }

    const state = {
      kind: 'exact',
      path: '/api/config-export/state',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        try { json(res, 200, { ok: true, ...host.state() }) }
        catch (error) { json(res, 500, { ok: false, error: error.message }) }
      },
    }

    const action = {
      kind: 'exact',
      path: '/api/config-export/action',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        let body
        try { body = await readBody(req, 300 * 1024 * 1024) } catch { return json(res, 413, { ok: false, error: 'too-large' }) }
        let parsed
        try { parsed = JSON.parse(body.toString('utf8')) } catch { return json(res, 400, { ok: false, error: 'bad-json' }) }
        try {
          if (parsed?.kind === 'export') {
            const result = await host.doExport(parsed.sections ?? [], Boolean(parsed.sanitize))
            json(res, 200, { ok: true, result })
          } else if (parsed?.kind === 'delete') {
            json(res, 200, { ok: true, result: host.deleteExport(parsed.name) })
          } else if (parsed?.kind === 'preview') {
            json(res, 200, { ok: true, result: await host.preview(parsed.name) })
          } else if (parsed?.kind === 'import') {
            json(res, 200, { ok: true, result: await host.doImport(parsed) })
          } else {
            json(res, 400, { ok: false, error: 'unknown-action' })
          }
        } catch (error) {
          json(res, 500, { ok: false, error: error.message })
        }
      },
    }

    for (const route of [state, action]) routes.push(ctx.webServer.register(route))
    return () => { for (const dispose of routes) dispose() }
  }, 'config-export: host routes')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:config-export',
    order: 211,
    text: CONFIG_EXPORT_GUIDANCE,
  }), 'config-export: system prompt section')
}
