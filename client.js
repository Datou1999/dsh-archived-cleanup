/**
 * Browser half of the archived-cleanup bundle.
 *
 * Renders one Settings section: the archived Sessions, their size, a checkbox
 * per row, and a guarded delete that asks the Host to back up and remove the
 * selected session directories. Titles and workspace names come from the
 * Client's own Workspace/Session snapshots, so nothing here re-parses logs.
 */

window.__ModuleLoader__.load({
  id: 'dsh-archived-cleanup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Session list and workspace list services, bound when they activate. */
    let SERVICES = null
    /** Last known Host facts (paths, per-session sizes, backups). */
    let INFO = null

    const ZH = /^zh/i.test(typeof navigator === 'object' && navigator.language ? navigator.language : 'en')
    /** Pick the locale-appropriate string. */
    const T = (zh, en) => (ZH ? zh : en)

    const API = {
      info: '/archived-cleanup/info',
      delete: '/archived-cleanup/delete',
      reveal: '/archived-cleanup/reveal',
    }

    /** Build a URL the current shell can reach on either transport. */
    function apiPath(path) {
      if (typeof window === 'object' && window.location && window.location.protocol === 'dsh-app:') {
        return '/api' + path
      }
      try {
        const base = new URL(document.baseURI || window.location.href)
        const dir = base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '')
        return dir + path.replace(/^\//, '')
      } catch {
        return path
      }
    }

    /** Call one Host route and surface structured failures as errors. */
    async function api(method, path, body) {
      const response = await fetch(apiPath(path), {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let value
      try {
        value = text ? JSON.parse(text) : {}
      } catch {
        value = { ok: false, error: text || 'invalid-response' }
      }
      if (!response.ok) {
        const reason = value?.message || value?.error || ('HTTP ' + response.status)
        const error = new Error(reason)
        error.payload = value
        throw error
      }
      return value
    }

    /* ------------------------------------------------------------------ */
    /* snapshot plumbing                                                   */
    /* ------------------------------------------------------------------ */

    // The Settings section registers before these optional services exist, so
    // every read falls back to a stable empty snapshot instead of throwing.
    const EMPTY_WORKSPACES = { archivedSessionIds: [], items: [] }
    const EMPTY_SESSIONS = { ids: [], byId: {} }

    const subscribeWorkspaces = listener => (SERVICES ? SERVICES.workspaces.list.subscribe(listener) : () => {})
    const readWorkspaces = () => (SERVICES ? SERVICES.workspaces.list.getSnapshot() : EMPTY_WORKSPACES)
    const subscribeSessions = listener => (SERVICES ? SERVICES.sessions.list.subscribe(listener) : () => {})
    const readSessions = () => (SERVICES ? SERVICES.sessions.list.getSnapshot() : EMPTY_SESSIONS)

    /** Every archived id, with the workspace that still accounts for it. */
    function collectRows(workspaces, sessions) {
      const owner = new Map()
      for (const item of workspaces.items ?? []) {
        for (const sessionId of item.sessionIds ?? []) {
          if (!owner.has(sessionId)) owner.set(sessionId, item)
        }
      }
      const children = new Map()
      for (const sessionId of Object.keys(sessions.byId ?? {})) {
        const summary = sessions.byId[sessionId]
        if (summary && typeof summary.parentId === 'string') {
          const list = children.get(summary.parentId) ?? []
          list.push(sessionId)
          children.set(summary.parentId, list)
        }
      }
      const countDescendants = (rootId) => {
        let total = 0
        const queue = [...(children.get(rootId) ?? [])]
        const seen = new Set()
        while (queue.length > 0) {
          const id = queue.pop()
          if (seen.has(id)) continue
          seen.add(id)
          total += 1
          queue.push(...(children.get(id) ?? []))
        }
        return total
      }
      const rows = []
      for (const sessionId of workspaces.archivedSessionIds ?? []) {
        const summary = sessions.byId?.[sessionId]
        const facts = (INFO?.sessions ?? []).find(session => session.sessionId === sessionId)
        rows.push({
          sessionId,
          title: summary?.displayTitle || summary?.title || sessionId,
          updatedAt: typeof summary?.updatedAt === 'number' ? summary.updatedAt : undefined,
          running: summary?.running === true,
          cwd: summary?.cwd || facts?.directory || '',
          workspaceTitle: owner.get(sessionId)?.title || T('未归属工作区', 'No workspace'),
          subagents: countDescendants(sessionId),
          bytes: facts?.bytes ?? 0,
          found: facts?.found !== false,
          live: facts?.live === true || summary?.running === true,
        })
      }
      rows.sort((left, right) => {
        if (left.workspaceTitle !== right.workspaceTitle) return left.workspaceTitle.localeCompare(right.workspaceTitle)
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      })
      return rows
    }

    /* ------------------------------------------------------------------ */
    /* formatting                                                          */
    /* ------------------------------------------------------------------ */

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return (unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[unit]
    }

    function formatWhen(updatedAt) {
      if (typeof updatedAt !== 'number' || updatedAt <= 0) return ''
      const delta = Date.now() - updatedAt
      if (delta < 60_000) return T('刚刚', 'just now')
      if (delta < 3_600_000) return T(Math.floor(delta / 60_000) + ' 分钟前', Math.floor(delta / 60_000) + ' min ago')
      if (delta < 86_400_000) return T(Math.floor(delta / 3_600_000) + ' 小时前', Math.floor(delta / 3_600_000) + ' h ago')
      if (delta < 7 * 86_400_000) return T(Math.floor(delta / 86_400_000) + ' 天前', Math.floor(delta / 86_400_000) + ' d ago')
      const date = new Date(updatedAt)
      const pad = value => String(value).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    /* ------------------------------------------------------------------ */
    /* styles                                                              */
    /* ------------------------------------------------------------------ */

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' },
      lead: { margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
      toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      spacer: { flex: '1 1 auto' },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      card: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden' },
      groupHeader: { padding: '8px 12px', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer' },
      rowTitle: { fontSize: '13px', lineHeight: 1.4, wordBreak: 'break-word' },
      rowMeta: { marginTop: '2px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      badge: { display: 'inline-block', marginLeft: '6px', padding: '0 6px', borderRadius: '999px', fontSize: '11px', lineHeight: '17px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' },
      badgeWarn: { borderColor: 'var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)' },
      button: { appearance: 'none', font: 'inherit', fontSize: '12.5px', padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      buttonPrimary: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      buttonDanger: { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      buttonDisabled: { opacity: 0.55, cursor: 'default' },
      buttonSmall: { padding: '2px 8px', fontSize: '11.5px', borderRadius: '6px' },
      notice: { padding: '9px 12px', borderRadius: '8px', fontSize: '12.5px', lineHeight: 1.5, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)' },
      noticeOk: { borderColor: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-state-success-primary)' },
      noticeError: { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      empty: { padding: '28px 12px', textAlign: 'center', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      scrim: { position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.38)' },
      dialog: { width: 'min(480px, calc(100vw - 48px))', padding: '18px', borderRadius: '12px', background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)', display: 'flex', flexDirection: 'column', gap: '12px' },
      dialogTitle: { margin: 0, fontSize: '15px', fontWeight: 650 },
      dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
      search: { font: 'inherit', fontSize: '12.5px', padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', minWidth: '180px' },
    }

    /* ------------------------------------------------------------------ */
    /* small building blocks                                               */
    /* ------------------------------------------------------------------ */

    function Checkbox({ checked, disabled, label, onChange }) {
      return h('input', {
        type: 'checkbox',
        checked,
        disabled,
        'aria-label': label,
        onChange: event => onChange(event.target.checked),
        style: { marginTop: '2px', width: '15px', height: '15px', accentColor: 'var(--dsw-alias-brand-primary)', cursor: disabled ? 'default' : 'pointer', flex: '0 0 auto' },
      })
    }

    function Button({ children, onClick, disabled, variant, size, title }) {
      const style = {
        ...S.button,
        ...(variant === 'primary' ? S.buttonPrimary : {}),
        ...(variant === 'danger' ? S.buttonDanger : {}),
        ...(size === 'small' ? S.buttonSmall : {}),
        ...(disabled ? S.buttonDisabled : {}),
      }
      return h('button', { type: 'button', onClick: disabled ? undefined : onClick, disabled, style, title }, children)
    }

    function Notice({ kind, children }) {
      const style = { ...S.notice, ...(kind === 'ok' ? S.noticeOk : {}), ...(kind === 'error' ? S.noticeError : {}) }
      return h('div', { role: 'status', style }, children)
    }

    /* ------------------------------------------------------------------ */
    /* the Settings page                                                   */
    /* ------------------------------------------------------------------ */

    function ArchivedCleanupPage() {
      const workspaces = React.useSyncExternalStore(subscribeWorkspaces, readWorkspaces)
      const sessions = React.useSyncExternalStore(subscribeSessions, readSessions)
      const [info, setInfo] = React.useState(INFO)
      const [selected, setSelected] = React.useState(() => new Set())
      const [filter, setFilter] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [confirming, setConfirming] = React.useState(false)
      const [loadingInfo, setLoadingInfo] = React.useState(INFO === null)
      const [revealing, setRevealing] = React.useState(false)

      const refreshInfo = React.useCallback(async () => {
        setLoadingInfo(true)
        try {
          const value = await api('GET', API.info)
          INFO = value
          setInfo(value)
          setError(null)
        } catch (failure) {
          setError(failure.message || String(failure))
        } finally {
          setLoadingInfo(false)
        }
      }, [])

      React.useEffect(() => {
        if (INFO === null) void refreshInfo()
        else setLoadingInfo(false)
      }, [refreshInfo])

      const rows = React.useMemo(() => collectRows(workspaces, sessions), [workspaces, sessions, info])
      const visible = React.useMemo(() => {
        const needle = filter.trim().toLowerCase()
        if (!needle) return rows
        return rows.filter(row => (row.title + ' ' + row.workspaceTitle + ' ' + row.cwd).toLowerCase().includes(needle))
      }, [rows, filter])

      // Selection survives list refreshes but never outlives its row.
      React.useEffect(() => {
        setSelected(previous => {
          const alive = new Set(rows.map(row => row.sessionId))
          let changed = false
          const next = new Set()
          for (const id of previous) {
            if (alive.has(id)) next.add(id)
            else changed = true
          }
          return changed ? next : previous
        })
      }, [rows])

      const selectable = visible.filter(row => row.found && !row.live)
      const allSelected = selectable.length > 0 && selectable.every(row => selected.has(row.sessionId))
      const selectedRows = rows.filter(row => selected.has(row.sessionId))
      const selectedBytes = selectedRows.reduce((sum, row) => sum + row.bytes, 0)
      const selectedSubagents = selectedRows.reduce((sum, row) => sum + row.subagents, 0)

      const toggle = (sessionId, next) => {
        setSelected(previous => {
          const copy = new Set(previous)
          if (next) copy.add(sessionId)
          else copy.delete(sessionId)
          return copy
        })
      }
      const toggleAll = () => {
        setSelected(previous => {
          const copy = new Set(previous)
          for (const row of selectable) {
            if (allSelected) copy.delete(row.sessionId)
            else copy.add(row.sessionId)
          }
          return copy
        })
      }

      const runReveal = async (name) => {
        setRevealing(true)
        setError(null)
        try {
          await api('POST', API.reveal, name === undefined ? {} : { name })
        } catch (failure) {
          setError(failure.message || String(failure))
        } finally {
          setRevealing(false)
        }
      }

      const runDelete = async () => {
        const targets = selectedRows.map(row => ({ sessionId: row.sessionId, cwd: row.cwd || undefined }))
        if (targets.length === 0) return
        setBusy(true)
        setConfirming(false)
        setError(null)
        setResult(null)
        try {
          const value = await api('POST', API.delete, { targets })
          setResult(value)
          setSelected(new Set())
          const removed = new Set((value.deleted ?? []).map(entry => entry.sessionId))
          if (removed.size > 0) {
            try {
              await SERVICES.sessions.refresh()
            } catch {
              // The next list refresh reconciles the removed rows anyway.
            }
          }
          await refreshInfo()
        } catch (failure) {
          setError(failure.message || String(failure))
        } finally {
          setBusy(false)
        }
      }

      const groups = []
      for (const row of visible) {
        const last = groups[groups.length - 1]
        if (last !== undefined && last.title === row.workspaceTitle) last.rows.push(row)
        else groups.push({ title: row.workspaceTitle, rows: [row] })
      }

      const totalBytes = info?.totals?.bytes ?? 0

      if (!SERVICES) {
        return h('div', { style: S.page },
          h('p', { style: S.lead },
            T('会话服务尚未就绪；本页会在工作区与会话列表可用后自动恢复。', 'The Session service is not available yet; this page recovers once the workspace and Session lists are ready.'),
          ),
        )
      }

      return h('div', { style: S.page },
        h('p', { style: S.lead },
          T(
            '归档只会把会话从侧栏隐藏，日志仍留在磁盘上。在这里选中要永久删除的归档会话；删除前会先完整备份到 ',
            'Archiving only hides a Session from the sidebar; its log stays on disk. Pick the archived Sessions you want to remove permanently — each one is fully backed up to ',
          ),
          h('code', { style: { fontSize: '12px' } }, info?.backupRoot || '~/.dsh/cleanup-backups'),
          T('，误删可以从备份目录恢复。', ' first, so an accidental deletion can be restored.'),
        ),

        error !== null ? h(Notice, { kind: 'error' }, T('操作失败：', 'Failed: '), error) : null,
        result !== null ? renderResult(result) : null,

        h('div', { style: S.toolbar },
          h(Button, { onClick: () => void refreshInfo(), disabled: busy || loadingInfo }, loadingInfo ? T('读取中…', 'Loading…') : T('刷新', 'Refresh')),
          h(Button, {
            onClick: () => void runReveal(),
            disabled: revealing,
            title: info?.backupRoot || T('备份目录', 'Backup folder'),
          }, revealing ? T('正在打开…', 'Opening…') : T('打开备份文件夹', 'Open backup folder')),
          h('span', { style: S.muted },
            info === null
              ? T('正在读取归档会话…', 'Reading archived sessions…')
              : T(
                '已归档 ' + rows.length + ' 个 · 可清理 ' + rows.filter(row => row.found && !row.live).length + ' 个 · 共 ' + formatBytes(totalBytes),
                rows.length + ' archived · ' + rows.filter(row => row.found && !row.live).length + ' reclaimable · ' + formatBytes(totalBytes) + ' total',
              )),
          h('span', { style: S.spacer }),
          h('input', {
            value: filter,
            placeholder: T('筛选标题或路径', 'Filter by title or path'),
            'aria-label': T('筛选归档会话', 'Filter archived sessions'),
            onChange: event => setFilter(event.target.value),
            style: S.search,
          }),
        ),

        h('div', { style: S.card },
          visible.length === 0
            ? h('div', { style: S.empty },
              rows.length === 0
                ? T('没有已归档的会话。在侧栏把会话归档后会出现在这里。', 'No archived sessions. Archive one from the sidebar and it shows up here.')
                : T('没有匹配的会话。', 'No session matches this filter.'))
            : groups.map(group => h('div', { key: group.title },
              h('div', { style: S.groupHeader }, group.title),
              group.rows.map(row => renderRow(row)),
            )),
        ),

        rows.length > 0
          ? h('div', { style: S.toolbar },
            h(Button, { onClick: toggleAll, disabled: busy || selectable.length === 0 }, allSelected ? T('取消全选', 'Clear all') : T('全选可清理项', 'Select all')),
            h('span', { style: S.muted },
              T('已选 ' + selectedRows.length + ' 个', selectedRows.length + ' selected'),
              selectedSubagents > 0 ? T('（另含 ' + selectedSubagents + ' 个子会话）', ' (+' + selectedSubagents + ' sub-Sessions)') : '',
              selectedBytes > 0 ? ' · ' + formatBytes(selectedBytes) : '',
            ),
            h('span', { style: S.spacer }),
            h(Button, {
              variant: 'danger',
              disabled: busy || selectedRows.length === 0 || selectedRows.some(row => row.live),
              onClick: () => setConfirming(true),
            }, busy ? T('正在删除…', 'Deleting…') : T('永久删除所选…', 'Delete selected…')),
          )
          : null,

        info?.backups?.length
          ? h('details', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
            h('summary', { style: { cursor: 'pointer' } }, T('最近的备份（' + info.backups.length + '）', 'Recent backups (' + info.backups.length + ')')),
            h('ul', { style: { margin: '8px 0 0', paddingLeft: '18px', lineHeight: 1.7 } },
              info.backups.map(backup => h('li', {
                key: backup.name,
                style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
              },
                h('span', {}, backup.name + ' · ' + formatWhen(Date.parse(backup.createdAt))),
                h(Button, {
                  size: 'small',
                  disabled: revealing,
                  onClick: () => void runReveal(backup.name),
                  title: backup.directory || backup.name,
                }, T('在文件夹中打开', 'Open')),
              )),
            ))
          : null,

        confirming
          ? h('div', { style: S.scrim, onClick: event => { if (event.target === event.currentTarget && !busy) setConfirming(false) } },
            h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': T('确认删除', 'Confirm deletion'), style: S.dialog },
              h('h2', { style: S.dialogTitle }, T('确认永久删除？', 'Delete permanently?')),
              h('div', { style: { fontSize: '13px', lineHeight: 1.6 } },
                T('将删除 ' + selectedRows.length + ' 个归档会话', 'This removes ' + selectedRows.length + ' archived Session(s)'),
                selectedSubagents > 0 ? T('及其 ' + selectedSubagents + ' 个子会话', ' and ' + selectedSubagents + ' sub-Session(s)') : '',
                T('，共 ' + formatBytes(selectedBytes) + '。删除后会话将从侧栏、会话列表与搜索索引中消失。', ' (' + formatBytes(selectedBytes) + '). They disappear from the sidebar, the session list and search.'),
              ),
              h('div', { style: { fontSize: '12.5px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
                T('删除前会自动备份到：', 'A backup is written to: '),
                h('code', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, info?.backupRoot || '~/.dsh/cleanup-backups'),
              ),
              h('div', { style: S.dialogActions },
                h(Button, { onClick: () => setConfirming(false), disabled: busy }, T('取消', 'Cancel')),
                h(Button, { variant: 'danger', onClick: () => void runDelete(), disabled: busy }, busy ? T('正在删除…', 'Deleting…') : T('确认删除', 'Delete')),
              ),
            ))
          : null,
      )

      /** One archived session row: checkbox, title, and its footprint. */
      function renderRow(row) {
        const disabled = busy || !row.found || row.live
        const checked = selected.has(row.sessionId)
        const meta = [formatWhen(row.updatedAt), row.bytes > 0 ? formatBytes(row.bytes) : null].filter(Boolean).join(' · ')
        return h('label', {
          key: row.sessionId,
          style: { ...S.row, ...(checked ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}) },
        },
          h(Checkbox, { checked, disabled, label: row.title, onChange: next => toggle(row.sessionId, next) }),
          h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
            h('div', { style: S.rowTitle }, row.title,
              row.subagents > 0 ? h('span', { style: S.badge }, T(row.subagents + ' 个子会话', row.subagents + ' sub')) : null,
              row.live ? h('span', { style: { ...S.badge, ...S.badgeWarn } }, T('使用中，无法删除', 'In use')) : null,
              !row.found ? h('span', { style: { ...S.badge, ...S.badgeWarn } }, T('文件已不存在', 'Files missing')) : null,
            ),
            h('div', { style: S.rowMeta }, meta, row.cwd ? ' · ' + row.cwd : ''),
          ),
        )
      }

      /** Human-readable outcome of one deletion run. */
      function renderResult(outcome) {
        const removed = outcome.deleted ?? []
        const skipped = outcome.skipped ?? []
        const failures = outcome.errors ?? []
        if (outcome.error === 'backup-failed') {
          return h(Notice, { kind: 'error' }, T('备份失败，未删除任何内容：', 'Backup failed, nothing was deleted: '), outcome.message || '')
        }
        const bytes = outcome.freedBytes ?? removed.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
        return h(Notice, { kind: failures.length === 0 ? 'ok' : 'error' },
          T('已删除 ' + removed.length + ' 个会话，释放 ' + formatBytes(bytes) + '。', 'Deleted ' + removed.length + ' Session(s), freeing ' + formatBytes(bytes) + '.'),
          outcome.backupDir ? h('div', { style: { marginTop: '4px', fontSize: '12px' } }, T('备份：', 'Backup: '), h('code', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, outcome.backupDir)) : null,
          skipped.length > 0
            ? h('div', { style: { marginTop: '4px', fontSize: '12px' } }, T('跳过 ' + skipped.length + ' 个（使用中、未归档或文件已缺失）。', 'Skipped ' + skipped.length + ' (in use, not archived, or already missing).'))
            : null,
          failures.length > 0
            ? h('div', { style: { marginTop: '4px', fontSize: '12px' } }, T('失败 ' + failures.length + ' 个：', 'Failed ' + failures.length + ': '), failures.map(entry => entry.sessionId + ' — ' + entry.message).join('; '))
            : null,
        )
      }
    }

    /** Trash-can glyph for the Settings navigation. */
    function CleanupIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9 7V5.4A1.4 1.4 0 0 1 10.4 4h3.2A1.4 1.4 0 0 1 15 5.4V7' }),
        h('path', { d: 'M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7' }),
        h('path', { d: 'M10 11v6M14 11v6' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'archived-cleanup',
          order: 45,
          label: () => T('归档会话清理', 'Archived cleanup'),
        }, props => h(ArchivedCleanupPage, props)))
        slots.inject('settings.section.icon', () => slots.register({
          name: 'settings.section.icon',
          id: 'archived-cleanup',
        }, props => h(CleanupIcon, props)))

        // Optional integrations must not gate the Settings page.
        ctx.inject(['sessions', 'workspaces'], (inner) => {
          const services = { sessions: inner.get('sessions'), workspaces: inner.get('workspaces') }
          SERVICES = services
          inner.effect(() => () => {
            if (SERVICES === services) SERVICES = null
          }, 'archived-cleanup.services')
        })
      },
    }
  },
})
