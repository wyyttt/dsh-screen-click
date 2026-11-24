/**
 * Host half of the dsh-screen-click bundle.
 *
 * Owns the monitor lifecycle and three private Web routes used by the sidebar
 * panel. The monitor itself is a Python process (`helper.py`) started from the
 * DSH runtime: it watches the dwrg.exe client area for the "准备案件还原"
 * button, clicks it repeatedly while it stays visible, and exits once the
 * button is gone.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_DIR = fileURLToPath(new URL('.', import.meta.url))
const PREFIX = '/dsh-screen-click'
const ROUTE_STATUS = PREFIX + '/status'
const ROUTE_START = PREFIX + '/start'
const ROUTE_STOP = PREFIX + '/stop'
const ROUTE_PROBE = PREFIX + '/probe'

export const inject = ['webServer']

const POLL_SECONDS = 0.4
const CLICK_INTERVAL_SECONDS = 0.45
const MISS_COUNT = 3
const WINDOW_WAIT_SECONDS = 0

let child = null
let stopping = false
let stderrTail = ''
let logger
const recent = []
let monitor = {
  state: 'idle',
  reason: null,
  message: '',
  clicks: 0,
  checks: 0,
  score: null,
  startedAt: null,
}

/**
 * Keep a compact trace of the last monitor events for the panel.
 * @param event - parsed helper event.
 */
function record(event) {
  const entry = {
    t: typeof event.ts === 'number' ? event.ts : Math.round(Date.now() / 1000),
    event: typeof event.event === 'string' ? event.event : 'unknown',
  }
  if (typeof event.score === 'number') entry.score = event.score
  if (event.matched === true) entry.matched = true
  if (event.fg === true || event.foreground === true) entry.fg = true
  if (event.event === 'check' && event.fg === false) entry.fg = false
  if (typeof event.clicks === 'number') entry.clicks = event.clicks
  if (typeof event.checks === 'number') entry.checks = event.checks
  if (typeof event.x === 'number') entry.x = event.x
  if (typeof event.y === 'number') entry.y = event.y
  if (typeof event.ok === 'boolean') entry.ok = event.ok
  if (typeof event.reason === 'string') entry.reason = event.reason
  recent.push(entry)
  if (recent.length > 15) recent.shift()
}

/**
 * Answer one route request as JSON.
 * @param res - the route response.
 * @param status - HTTP status code.
 * @param payload - JSON body.
 */
function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * Read a small JSON request body.
 * @param req - the route request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed JSON value.
 */
function readJsonBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (size > limit) {
        req.destroy()
        reject(new Error('Request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = chunks.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).join('')
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * The Python interpreter shipped with the DSH runtime, or `python.exe` from PATH.
 * The desktop host receives its primary-runtime directory in argv, and the DSH
 * home may be present for profile-launched processes; both are tried first.
 * @returns executable name or absolute path.
 */
function pythonExecutable() {
  const candidates = []
  for (const arg of process.argv) {
    if (typeof arg === 'string' && /primary-runtime[\\/]?$/.test(arg)) {
      candidates.push(join(arg, 'dependencies', 'python', 'python.exe'))
    }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    candidates.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  candidates.push(join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'))
  candidates.push(join(process.cwd(), '..', '..', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  candidates.push('python.exe')
  for (const candidate of candidates) {
    if (candidate === 'python.exe' || existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Fold one helper status line into the monitor state.
 * @param event - parsed JSON line.
 */
function handleEvent(event) {
  if (event === null || typeof event !== 'object') return
  record(event)
  const kind = event.event
  if (typeof event.clicks === 'number') monitor.clicks = event.clicks
  if (typeof event.checks === 'number') monitor.checks = event.checks
  if (typeof event.score === 'number') monitor.score = event.score
  if (kind === 'ready') {
    monitor.state = 'running'
    monitor.message = '监控中'
    return
  }
  if (kind === 'waiting-window') {
    monitor.state = 'running'
    monitor.message = '等待 dwrg.exe 窗口…'
    return
  }
  if (kind === 'window-found') {
    monitor.state = 'running'
    monitor.message = '已找到窗口，等待目标画面'
    return
  }
  if (kind === 'waiting-foreground') {
    monitor.state = 'running'
    monitor.message = '请把 dwrg.exe 切到前台'
    return
  }
  if (kind === 'waiting-target') {
    monitor.state = 'running'
    monitor.message = '等待目标画面出现'
    return
  }
  if (kind === 'click') {
    monitor.state = 'running'
    monitor.message = '已点击 ' + String(event.clicks) + ' 次'
    return
  }
  if (kind === 'check') {
    if (monitor.state === 'running' && monitor.message === '') monitor.message = '监控中'
    return
  }
  if (kind === 'stopped') {
    monitor.state = 'stopped'
    monitor.reason = typeof event.reason === 'string' ? event.reason : 'exited'
    monitor.message = typeof event.message === 'string' && event.message.length > 0
      ? event.message
      : monitor.reason === 'target-gone' ? '目标画面已消失，已停止' : '监测已停止'
    return
  }
  if (kind === 'error') {
    monitor.state = 'error'
    monitor.message = typeof event.message === 'string' ? event.message : '监测出错'
  }
}

/**
 * Spawn the helper and stream its status lines.
 */
function startMonitor() {
  if (child !== null) return
  const python = pythonExecutable()
  if (python === undefined) throw new Error('找不到 Python 运行环境')
  const helper = join(BUNDLE_DIR, 'helper.py')
  const config = join(BUNDLE_DIR, 'signature.json')
  if (!existsSync(helper) || !existsSync(config)) throw new Error('插件文件不完整')
  monitor = {
    state: 'starting',
    reason: null,
    message: '正在启动监测…',
    clicks: 0,
    checks: 0,
    score: null,
    startedAt: Date.now(),
  }
  recent.length = 0
  stderrTail = ''
  stopping = false
  const proc = spawn(python, [
    '-u',
    helper,
    '--config',
    config,
    '--process',
    'dwrg.exe',
    '--poll',
    String(POLL_SECONDS),
    '--click-interval',
    String(CLICK_INTERVAL_SECONDS),
    '--misses',
    String(MISS_COUNT),
    '--window-wait',
    String(WINDOW_WAIT_SECONDS),
  ], { cwd: BUNDLE_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (line.length === 0) return
    try {
      handleEvent(JSON.parse(line))
    } catch (_error) {
      // Ignore non-JSON output; the helper only writes JSON lines.
    }
  })
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4096)
  })
  proc.on('error', (error) => {
    if (child !== proc) return
    child = null
    monitor.state = 'error'
    monitor.message = '无法启动监测进程：' + error.message
    logger?.warn?.('monitor spawn failed', error)
  })
  proc.on('exit', (code, signal) => {
    if (child !== proc) return
    child = null
    if (monitor.state === 'starting' || monitor.state === 'running') {
      monitor.state = 'stopped'
      monitor.reason = stopping ? 'user' : 'exited'
      const detail = stderrTail.trim().length > 0 ? stderrTail.trim() : `exit code=${String(code)} signal=${String(signal)}`
      monitor.message = stopping ? '已手动停止' : detail
      logger?.warn?.('monitor exited unexpectedly', detail)
    }
    stopping = false
  })
}

/** Stop the helper; the exit handler settles the final state. */
function stopMonitor(reason) {
  stopping = true
  if (child !== null) {
    const proc = child
    child = null
    proc.kill()
  }
  monitor.state = 'stopped'
  monitor.reason = reason
  monitor.message = reason === 'user' ? '已手动停止' : monitor.message
}

/**
 * Capture one window frame and report whether it matches, both from the screen
 * and through PrintWindow, so the panel can explain background limitations.
 * @returns the helper's probe JSON line.
 */
function runProbe() {
  return new Promise((resolve) => {
    let settled = false
    let proc
    const finish = (payload) => {
      if (settled) return
      settled = true
      try {
        proc?.kill()
      } catch (_error) {
        // Already exited.
      }
      resolve(payload)
    }
    const python = pythonExecutable()
    if (python === undefined) {
      resolve({ event: 'probe', error: 'python-missing' })
      return
    }
    proc = spawn(python, [
      '-u', join(BUNDLE_DIR, 'helper.py'), '--config', join(BUNDLE_DIR, 'signature.json'),
      '--probe-window', '--window-wait', '3',
    ], { cwd: BUNDLE_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let lastEvent = null
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096)
    })
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const event = JSON.parse(line)
        lastEvent = event
        if (event.event === 'probe') finish(event)
      } catch (_error) {
        // Ignore non-JSON output.
      }
    })
    proc.on('error', (error) => finish({ event: 'probe', error: error.message }))
    proc.on('exit', (code) => finish({ event: 'probe', error: 'no-output', stderr, lastEvent, code }))
    setTimeout(() => finish({ event: 'probe', error: 'timeout' }), 15000)
  })
}

/**
 * Register the routes.
 * @param ctx - profile context.
 */
export function apply(ctx) {
  logger = ctx.logger?.('dsh-screen-click')
  ctx.effect(() => () => stopMonitor('user'))
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === ROUTE_STATUS) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        respond(res, 200, { ok: true, status: { ...monitor, recent } })
        return
      }
      if (path === ROUTE_PROBE) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        respond(res, 200, { ok: true, probe: await runProbe() })
        return
      }
      if (path !== ROUTE_START && path !== ROUTE_STOP) {
        respond(res, 404, { ok: false, message: 'Unknown route.' })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        respond(res, 415, { ok: false, message: 'Expected a JSON request.' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (_error) {
        respond(res, 400, { ok: false, message: 'Invalid request body.' })
        return
      }
      const expected = path === ROUTE_START ? 'start' : 'stop'
      if (body === null || typeof body !== 'object' || body.action !== expected) {
        respond(res, 400, { ok: false, message: 'Invalid action.' })
        return
      }
      try {
        if (expected === 'start') {
          if (child === null) startMonitor()
          else {
            // The helper may still be running from a previous page: report it.
            monitor.message = monitor.message || '监控中'
          }
        } else {
          stopMonitor('user')
        }
        respond(res, 200, { ok: true, status: monitor })
      } catch (error) {
        monitor.state = 'error'
        monitor.message = error instanceof Error ? error.message : String(error)
        respond(res, 500, { ok: false, message: monitor.message, status: monitor })
      }
    },
  }))
}
