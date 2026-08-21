window.__ModuleLoader__.load({
  id: "dsh-config-export",
  factory: (require) => {
/**
 * dsh-config-export — browser half.
 *
 * Sidebar entry (self-healing DOM insert, same approach as SSH/task-board)
 * opening a panel: checkbox list of config sections with sizes, export with
 * optional secret sanitization, backup history with preview/delete, and
 * restore (with safety-snapshot confirmation) plus upload-import.
 * Failure policy: log/alert, never throw into the web GUI.
 */

const inject = ['connection']

const ROW_ATTR = 'data-config-export-entry'
const PANEL_ID = 'dsh-config-export-panel'
const POLL_MS = 30_000 // panel state poll

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'style') Object.assign(node.style, value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    if (child == null) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const css = `
#${PANEL_ID} {
  --ce-surface: #1c1f26; --ce-border: rgba(255,255,255,.09); --ce-divider: rgba(255,255,255,.07);
  --ce-text: rgba(255,255,255,.88); --ce-muted: rgba(255,255,255,.55); --ce-hover: rgba(255,255,255,.08);
  --ce-accent-bg: rgba(80,160,255,.22); --ce-accent-border: rgba(80,160,255,.5); --ce-accent-fg: #7ab5ff;
  --ce-ok: #7ad39a; --ce-err: #ff9a9a;
  --ce-warn-bg: rgba(255,170,80,.12); --ce-warn-border: rgba(255,170,80,.3);
}
#${PANEL_ID}[data-theme="light"] {
  --ce-surface: #ffffff; --ce-border: rgba(23,35,71,.14); --ce-divider: rgba(23,35,71,.1);
  --ce-text: #1b2a52; --ce-muted: rgba(27,42,82,.55); --ce-hover: rgba(23,35,71,.06);
  --ce-accent-bg: rgba(31,95,168,.1); --ce-accent-border: rgba(31,95,168,.45); --ce-accent-fg: #1f5fa8;
  --ce-ok: #1a7f37; --ce-err: #c62828;
  --ce-warn-bg: rgba(214,125,2,.08); --ce-warn-border: rgba(214,125,2,.35);
}
#${PANEL_ID} { position: fixed; inset: 0; right: 0; width: min(560px, 92vw); background: var(--ce-surface); color: var(--ce-text); box-shadow: -8px 0 32px rgba(0,0,0,.18); z-index: 60; display: flex; flex-direction: column; font-size: 13px; }
#${PANEL_ID} .ce-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--ce-border); font-weight: 600; }
#${PANEL_ID} .ce-body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
#${PANEL_ID} .ce-card { border: 1px solid var(--ce-border); border-radius: 10px; padding: 10px 12px; }
#${PANEL_ID} .ce-title { font-weight: 600; margin-bottom: 6px; }
#${PANEL_ID} .ce-muted { color: var(--ce-muted); font-size: 12px; }
#${PANEL_ID} .ce-btn { border: 1px solid var(--ce-border); background: transparent; color: var(--ce-text); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
#${PANEL_ID} .ce-btn:hover { background: var(--ce-hover); }
#${PANEL_ID} .ce-btn.ce-primary { background: var(--ce-accent-bg); border-color: var(--ce-accent-border); color: var(--ce-accent-fg); }
#${PANEL_ID} .ce-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
#${PANEL_ID} .ce-close { margin-left: auto; }
#${PANEL_ID} .ce-section { display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px; border-bottom: 1px dashed var(--ce-divider); }
#${PANEL_ID} .ce-section:last-child { border-bottom: none; }
#${PANEL_ID} .ce-section input { margin-top: 2px; }
#${PANEL_ID} .ce-size { margin-left: auto; color: var(--ce-muted); font-size: 12px; white-space: nowrap; }
#${PANEL_ID} .ce-ok { color: var(--ce-ok); }
#${PANEL_ID} .ce-err { color: var(--ce-err); }
#${PANEL_ID} .ce-backup { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px dashed var(--ce-divider); }
#${PANEL_ID} .ce-backup:last-child { border-bottom: none; }
#${PANEL_ID} .ce-badge { display: inline-block; border-radius: 6px; padding: 1px 6px; background: var(--ce-accent-bg); color: var(--ce-accent-fg); font-size: 11px; }
#${PANEL_ID} .ce-warn { background: var(--ce-warn-bg); border: 1px solid var(--ce-warn-border); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--ce-text); }
[${ROW_ATTR}] { display: flex; align-items: center; gap: 8px; width: calc(100% - 16px); margin: 0 8px; padding: 7px 10px; background: transparent; border: none; border-radius: 8px; color: inherit; font-size: 13px; cursor: pointer; text-align: left; }
[${ROW_ATTR}]:hover { background: rgba(127,127,127,.12); }
[${ROW_ATTR}] svg { width: 16px; height: 16px; flex: none; }
`

let opened = false
let state = null
let message = null // { kind: 'ok'|'err', text }
let selected = new Set(['settings', 'profiles'])
let sanitize = true
let pollTimer = 0

async function api(path, init) {
  const response = await fetch(path, init)
  const body = await response.json()
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function refresh() {
  try {
    const body = await api('/api/config-export/state', { cache: 'no-store' })
    state = body
    if (opened) renderPanelContent()
  } catch { /* host unreachable — keep last state */ }
}

async function act(payload) {
  message = null
  try {
    const body = await api('/api/config-export/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (payload.kind === 'export' && body.result) {
      message = { kind: 'ok', text: `已导出 ${body.result.name}（${body.result.sizeText}${body.result.redacted ? `，脱敏 ${body.result.redacted} 个字段` : ''}）` }
    } else if (payload.kind === 'import' && body.result) {
      message = { kind: 'ok', text: `已恢复：${body.result.restored.join(', ')}。恢复前快照存于 exports/safety/。${body.result.note ?? ''}` }
    } else if (payload.kind === 'preview' && body.result) {
      message = { kind: 'ok', text: `${body.result.name}：含 ${body.result.entries} 个条目，覆盖 ${body.result.sections.join(', ') || '（无已知配置项）'}` }
    }
  } catch (error) {
    message = { kind: 'err', text: error.message }
  }
  await refresh()
}

function fmtTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

async function uploadImport(file) {
  message = null
  if (!confirm(`确认从「${file.name}」恢复配置？恢复前会自动把现有相关配置快照到 exports/safety/。`)) return
  try {
    const buffer = new Uint8Array(await file.arrayBuffer())
    await act({ kind: 'import', buffer: Array.from(buffer), name: file.name })
  } catch (error) {
    message = { kind: 'err', text: `读取文件失败：${error.message}` }
    renderPanelContent()
  }
}

function renderPanelContent() {
  const panel = document.getElementById(PANEL_ID)
  const body = panel?.querySelector(`.ce-body`)
  if (panel != null) panel.dataset.theme = detectTheme()
  if (body == null || state == null) return
  body.replaceChildren()

  if (message != null) {
    body.append(el('div', { class: message.kind === 'ok' ? 'ce-ok' : 'ce-err' }, message.text))
  }

  // --- Export ---
  const sectionsWrap = el('div', { class: 'ce-card' },
    el('div', { class: 'ce-title' }, '📦 选择要导出的配置'),
  )
  for (const section of state.sections ?? []) {
    const checked = selected.has(section.id)
    sectionsWrap.append(
      el('label', { class: 'ce-section' },
        el('input', {
          type: 'checkbox',
          checked,
          onchange: e => {
            if (e.target.checked) selected.add(section.id)
            else selected.delete(section.id)
          },
        }),
        el('span', {},
          el('div', {}, section.label, section.sensitive ? ' ' : null, section.sensitive ? el('span', { class: 'ce-badge' }, '含密码') : null),
          el('div', { class: 'ce-muted' }, section.desc),
        ),
        el('span', { class: 'ce-size' }, section.present ? section.size : '不存在'),
      ),
    )
  }
  sectionsWrap.append(
    el('div', { class: 'ce-row', style: { marginTop: '8px' } },
      el('label', {},
        el('input', { type: 'checkbox', checked: sanitize, onchange: e => { sanitize = e.target.checked } }),
        ' 脱敏密码等敏感字段',
      ),
      el('button', {
        class: 'ce-btn ce-primary',
        style: { marginLeft: 'auto' },
        onclick: () => act({ kind: 'export', sections: [...selected], sanitize }),
      }, '导出备份'),
    ),
    el('div', { class: 'ce-muted' }, `导出到 ${state.exportDir ?? '~/.dsh/exports/'}；profile 打包不含 node_modules。`),
  )
  body.append(sectionsWrap)

  // --- Backup history ---
  const historyWrap = el('div', { class: 'ce-card' },
    el('div', { class: 'ce-title' }, '🗂 备份历史'),
  )
  const backups = state.exports ?? []
  if (backups.length === 0) {
    historyWrap.append(el('div', { class: 'ce-muted' }, '暂无备份。'))
  }
  for (const backup of backups) {
    historyWrap.append(
      el('div', { class: 'ce-backup' },
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: backup.name }, backup.name),
        el('span', { class: 'ce-muted' }, `${backup.sizeText} · ${fmtTime(backup.at)}`),
        el('button', { class: 'ce-btn', onclick: () => act({ kind: 'preview', name: backup.name }) }, '预览'),
        el('button', {
          class: 'ce-btn',
          onclick: () => {
            if (confirm(`确认用「${backup.name}」恢复配置？现有相关配置会先快照到 exports/safety/。`)) {
              act({ kind: 'import', name: backup.name })
            }
          },
        }, '恢复'),
        el('button', {
          class: 'ce-btn',
          onclick: () => {
            if (confirm(`删除备份「${backup.name}」？`)) act({ kind: 'delete', name: backup.name })
          },
        }, '删除'),
      ),
    )
  }
  // Upload import
  const fileInput = el('input', { type: 'file', accept: '.tar.gz,.tgz,application/gzip', style: { display: 'none' }, onchange: e => {
    const file = e.target.files?.[0]
    if (file != null) uploadImport(file)
    e.target.value = ''
  } })
  historyWrap.append(
    el('div', { class: 'ce-row', style: { marginTop: '8px' } },
      el('button', { class: 'ce-btn', onclick: () => fileInput.click() }, '⬆ 从本地备份包导入'),
      fileInput,
    ),
  )
  body.append(historyWrap)

  // --- Restore notice ---
  body.append(el('div', { class: 'ce-warn' },
    '⚠ 恢复 profile 类配置后需重启 dsh web；插件依赖如缺失可在 profile 目录执行 dsh plugin --profile <profile> install 重装。恢复操作前都会自动在 exports/safety/ 生成当前配置快照。',
  ))
}

function detectTheme() {
  try {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g)
    if (bg == null || bg.length < 3) return 'dark'
    const [r, g, b] = bg.map(Number)
    // perceived luminance (Rec.709) — light skins land well above 0.5
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? 'light' : 'dark'
  } catch { return 'dark' }
}

function openPanel() {
  opened = true
  document.getElementById(PANEL_ID)?.remove()
  const panel = el('div', { id: PANEL_ID, 'data-theme': detectTheme() },
    el('div', { class: 'ce-head' },
      '🧳 配置备份',
      el('button', { class: 'ce-btn ce-close', onclick: closePanel }, '关闭'),
    ),
    el('div', { class: 'ce-body' }, '加载中…'),
  )
  document.body.append(panel)
  renderPanelContent()
  refresh()
}

function closePanel() {
  opened = false
  document.getElementById(PANEL_ID)?.remove()
}

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'

function injectSidebarRow() {
  if (document.querySelector(`[${ROW_ATTR}]`)) return
  const root = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (root == null) return
  const row = el('button', {
    [ROW_ATTR]: '',
    type: 'button',
    'aria-label': '配置备份',
    title: 'DSH 配置导出 / 导入备份',
    onclick: () => (opened ? closePanel() : openPanel()),
  })
  row.innerHTML = `${ICON}<span>配置备份</span>`
  const anchor = root.querySelector('[data-patent-radar-entry], [data-dsh-ssh-entry], [data-dsh-taskboard-entry], [class*="taskBoardEntry"], [data-dsh-plugin]')
  if (anchor != null) anchor.insertAdjacentElement('afterend', row)
  else root.prepend(row)
}

function apply(ctx) {
  const style = el('style', {}, css)
  document.head.append(style)
  const observer = new MutationObserver(() => injectSidebarRow())
  observer.observe(document.body, { childList: true, subtree: true })
  injectSidebarRow()
  pollTimer = setInterval(refresh, POLL_MS)
  refresh()
  ctx.effect(() => {
    return () => {
      observer.disconnect()
      clearInterval(pollTimer)
      style.remove()
      document.querySelector(`[${ROW_ATTR}]`)?.remove()
      closePanel()
    }
  }, 'config-export: client panel')
}

    return { inject, apply }
  },
})
