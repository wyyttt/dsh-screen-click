/**
 * Client half of the dsh-screen-click bundle.
 *
 * The sidebar entry opens this panel, which automatically starts the Host
 * monitor. The panel polls the Host status while it is open, so a monitor that
 * ended by itself (target gone) shows as stopped instead of silently stopping.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-screen-click',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-screen-click'
    const STATUS_ROUTE = '/dsh-screen-click/status'
    const START_ROUTE = '/dsh-screen-click/start'
    const STOP_ROUTE = '/dsh-screen-click/stop'

    const zh = {
      'entry.label': '第五人格准备',
      'page.title': '第五人格准备',
      'page.description': '监测 dwrg.exe 窗口；出现「准备案件还原」按钮时自动点击，按钮消失后自动停止。',
      'state.connecting': '正在读取监测状态…',
      'state.idle': '未开始',
      'state.starting': '正在启动监测…',
      'state.running': '监控中',
      'state.completed': '目标画面已消失，监测已停止',
      'state.noWindow': '没找到 dwrg.exe 窗口，请先启动游戏',
      'state.windowClosed': '游戏窗口已关闭，监测已停止',
      'state.stoppedByUser': '已手动停止',
      'state.stopped': '已停止',
      'state.error': '出错',
      'stats.clicks': '已点击 {count} 次',
      'stats.score': '匹配分 {score}',
      'action.stop': '停止监测',
      'action.start': '开始监测',
      'action.restart': '重新开始监测',
      'hint.foreground': '游戏可以在后台运行；命中时会把 dwrg.exe 窗口切到前台再点击。若后台截图取不到画面，请让游戏窗口可见。',
      'hint.auto': '打开此面板会自动开始监测。',
    }

    const en = {
      'entry.label': 'Identity V ready',
      'page.title': 'Identity V ready',
      'page.description': 'Watches the dwrg.exe window, clicks the “准备案件还原” button while it is visible, and stops when it disappears.',
      'state.connecting': 'Reading monitor status…',
      'state.idle': 'Not started',
      'state.starting': 'Starting monitor…',
      'state.running': 'Monitoring',
      'state.completed': 'Target screen is gone; monitoring stopped',
      'state.noWindow': 'dwrg.exe window not found — start the game first',
      'state.windowClosed': 'Game window closed; monitoring stopped',
      'state.stoppedByUser': 'Stopped manually',
      'state.stopped': 'Stopped',
      'state.error': 'Error',
      'stats.clicks': 'Clicked {count} times',
      'stats.score': 'Match score {score}',
      'action.stop': 'Stop monitoring',
      'action.start': 'Start monitoring',
      'action.restart': 'Restart monitoring',
      'hint.foreground': 'The game may run in the background; on a match the dwrg.exe window is brought to the front before clicking. If background capture fails, keep the game visible.',
      'hint.auto': 'Opening this panel starts monitoring automatically.',
    }

    const CSS = `
      .dsc-row-glyph{display:inline-flex;align-items:center;justify-content:center;color:inherit}
      .dsc-page{box-sizing:border-box;height:100%;min-height:0;display:flex;align-items:center;justify-content:center;padding:32px}
      .dsc-card{box-sizing:border-box;width:min(480px,100%);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
      .dsc-head{display:flex;align-items:center;gap:12px}
      .dsc-icon{width:44px;height:44px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);flex:none}
      .dsc-title{margin:0;font-size:20px;line-height:28px;font-weight:600}
      .dsc-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
      .dsc-status{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px}
      .dsc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
      .dsc-dot[data-tone=running]{background:var(--dsw-alias-state-success-primary)}
      .dsc-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
      .dsc-stats{display:flex;gap:16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
      .dsc-actions{display:flex;gap:10px;margin-top:4px}
      .dsc-primary{appearance:none;border:none;border-radius:10px;background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;font-size:14px;line-height:20px;font-weight:500;padding:9px 18px;cursor:pointer}
      .dsc-primary:hover{filter:brightness(1.06)}
      .dsc-primary:disabled{opacity:.6;cursor:default;filter:none}
      .dsc-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      .dsc-secondary{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;padding:8px 16px;cursor:pointer}
      .dsc-secondary:hover{background:var(--dsw-alias-bg-layer-2)}
      .dsc-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dsc-log{margin-top:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsc-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
    `

    /** Target/crosshair icon. */
    function MonitorIcon({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('circle', { cx: 10, cy: 10, r: 5.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M10 1.8v3.4M10 14.8v3.4M1.8 10h3.4M14.8 10h3.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('circle', { cx: 10, cy: 10, r: 1.5, fill: 'currentColor' }))
    }

    async function request(method, url, body) {
      const options = { method, headers: { accept: 'application/json' } }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await fetch(url, options)
      let payload = null
      try {
        payload = await response.json()
      } catch (_error) {
        // A non-JSON answer means the route is not available.
      }
      if (!response.ok) {
        const message = payload !== null && typeof payload === 'object' && typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    function statusText(status, t) {
      if (status === null) return t('state.connecting')
      if (status.state === 'starting') return t('state.starting')
      if (status.state === 'running') {
        const detail = typeof status.message === 'string' && status.message.length > 0 ? status.message : ''
        return detail.length > 0 ? `${t('state.running')} · ${detail}` : t('state.running')
      }
      if (status.state === 'error') {
        const detail = typeof status.message === 'string' && status.message.length > 0 ? `: ${status.message}` : ''
        return `${t('state.error')}${detail}`
      }
      if (status.state === 'stopped') {
        if (status.reason === 'target-gone' || status.reason === 'completed') return t('state.completed')
        if (status.reason === 'window-missing') return t('state.noWindow')
        if (status.reason === 'window-closed') return t('state.windowClosed')
        if (status.reason === 'user') return t('state.stoppedByUser')
        return t('state.stopped')
      }
      return t('state.idle')
    }

    function statusTone(status) {
      if (status === null) return 'idle'
      if (status.state === 'running' || status.state === 'starting') return 'running'
      if (status.state === 'error') return 'error'
      return 'idle'
    }

    /** Start a monitoring session from the sidebar icon itself. */
    async function startNow() {
      try {
        await request('POST', START_ROUTE, { action: 'start' })
      } catch (_error) {
        // The panel reports the failure when it opens.
      }
    }

    /** One compact line for the recent-event trace. */
    function formatEvent(entry) {
      const parts = []
      if (typeof entry.checks === 'number') parts.push('#' + String(entry.checks))
      parts.push(entry.event)
      if (typeof entry.score === 'number') parts.push('score ' + entry.score.toFixed(1))
      if (entry.event === 'check') {
        parts.push(entry.matched ? 'HIT' : 'miss')
        if (entry.fg === false) parts.push('bg')
        else if (entry.fg === true) parts.push('fg')
      }
      if (entry.event === 'click') parts.push('@' + String(entry.x) + ',' + String(entry.y))
      if (entry.event === 'bring') parts.push(entry.ok ? 'ok' : 'FAIL')
      if (typeof entry.reason === 'string') parts.push(entry.reason)
      return parts.join(' · ')
    }

    /** Sidebar row glyph. Clicking it starts monitoring even while the panel is open. */
    function MonitorGlyph({ size }) {
      return h('span', { className: 'dsc-row-glyph', onClick: startNow }, h(MonitorIcon, { size: size ?? 16 }))
    }

    /** Monitoring panel. */
    function MonitorPanel({ t }) {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const applyStatus = React.useCallback((payload) => {
        if (payload !== null && typeof payload === 'object' && payload.status !== undefined) {
          setStatus(payload.status)
        }
      }, [])

      React.useEffect(() => {
        let live = true
        const read = async () => {
          try {
            const payload = await request('GET', STATUS_ROUTE)
            if (!live) return
            applyStatus(payload)
            return payload.status
          } catch (failure) {
            if (live) setError(failure instanceof Error ? failure.message : String(failure))
            return null
          }
        }
        const boot = async () => {
          const current = await read()
          if (!live || current === null) return
          if (current.state === 'idle' || current.state === 'stopped' || current.state === 'error') {
            try {
              setBusy(true)
              const payload = await request('POST', START_ROUTE, { action: 'start' })
              if (live) applyStatus(payload)
            } catch (failure) {
              if (live) setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              if (live) setBusy(false)
            }
          }
        }
        boot()
        const timer = setInterval(async () => {
          try {
            const payload = await request('GET', STATUS_ROUTE)
            if (!live) return
            applyStatus(payload)
          } catch (_failure) {
            // Keep the last status; the next poll retries.
          }
        }, 800)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [applyStatus])

      const stop = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const payload = await request('POST', STOP_ROUTE, { action: 'stop' })
          applyStatus(payload)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [applyStatus])

      const start = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const payload = await request('POST', START_ROUTE, { action: 'start' })
          applyStatus(payload)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [applyStatus])

      const running = status !== null && (status.state === 'running' || status.state === 'starting')
      const clicks = status !== null && typeof status.clicks === 'number' ? status.clicks : 0
      const score = status !== null && typeof status.score === 'number' ? status.score : null
      const recent = status !== null && Array.isArray(status.recent) ? status.recent.slice(-4) : []
      return h('div', { className: 'dsc-page' },
        h('section', { className: 'dsc-card' },
          h('div', { className: 'dsc-head' },
            h('div', { className: 'dsc-icon' }, h(MonitorIcon, { size: 24 })),
            h('div', null,
              h('h1', { className: 'dsc-title' }, t('page.title')),
              h('p', { className: 'dsc-text' }, t('page.description')))),
          h('div', { className: 'dsc-status' },
            h('span', { className: 'dsc-dot', 'data-tone': statusTone(status) }),
            h('span', null, statusText(status, t))),
          error !== null && h('p', { className: 'dsc-error', role: 'alert' }, error),
          h('div', { className: 'dsc-stats' },
            h('span', null, t('stats.clicks', { count: clicks })),
            score !== null && h('span', null, t('stats.score', { score: score.toFixed(1) }))),
          recent.length > 0 && h('div', { className: 'dsc-log', 'aria-label': 'recent events' },
            recent.map((entry, index) => h('div', { key: String(index) }, formatEvent(entry)))),
          h('div', { className: 'dsc-actions' },
            running
              ? h('button', { type: 'button', className: 'dsc-secondary', disabled: busy, onClick: stop }, t('action.stop'))
              : h('button', { type: 'button', className: 'dsc-primary', disabled: busy, onClick: start },
                status !== null && status.state === 'stopped' ? t('action.restart') : t('action.start'))),
          h('p', { className: 'dsc-hint' }, t('hint.foreground')),
          h('p', { className: 'dsc-hint' }, t('hint.auto'))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-screen-click: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshScreenClick = ''
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'dsh-screen-click: styles')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'screen-click',
          order: 6,
          label: () => t('entry.label'),
          locale: NS,
          inject: () => ({ t }),
        }, MonitorGlyph))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'screen-click',
          locale: NS,
          inject: () => ({ t }),
        }, MonitorPanel))
      },
    }
  },
})
