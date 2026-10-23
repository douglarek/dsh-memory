/**
 * Automatic session capture.
 *
 * Every completed turn becomes a bounded Markdown section in the workspace's
 * `sessions/` directory. Captures are append-only, deduplicated by turn number,
 * and written through a per-plugin queue so a turn boundary never blocks the
 * agent loop.
 *
 * @module dsh-memory/capture
 */

import { dirname, resolve } from 'node:path'
import { appendText, ensureDir, statSafe } from './fsutil.js'
import { dateStamp, firstLine, isoNow, truncateText } from './text.js'
import { slugify } from './paths.js'

/**
 * @typedef {object} CaptureState
 * @property {number} turn
 * @property {boolean} open
 * @property {boolean} skip
 * @property {string[]} user
 * @property {string} assistant
 * @property {Set<string>} tools
 * @property {string} lastUserText
 */

export class CaptureManager {
  /**
   * @param {object} options
   * @param {import('./config.js').MemoryConfig} options.config
   * @param {(session:object)=>Promise<{store:import('./store.js').MemoryStore, workspace:object|null}|null>} options.resolveStore
   * @param {{warn?:Function,debug?:Function}} [options.logger]
   */
  constructor(options) {
    this.config = options.config
    this.resolveStore = options.resolveStore
    this.logger = options.logger ?? {}
    /** @type {WeakMap<object,CaptureState>} */
    this.states = new WeakMap()
    /** @type {Map<string,{path:string,absolutePath:string,seen:Set<number>,title:string,part:number}>} */
    this.files = new Map()
    /** @type {Map<string,string>} */
    this.lastSaved = new Map()
    this.queue = Promise.resolve()
  }

  /** Observe one committed session event. */
  observe(session, event) {
    if (!this.config.captureEnabled) return
    if (isSubagent(session) && !this.config.captureSubagents) return
    if (typeof event?.type !== 'string') return

    if (event.type === 'turn/start') {
      const state = this.stateOf(session)
      state.turn = Number.isInteger(event.data?.turn) ? event.data.turn : state.turn + 1
      state.open = true
      state.skip = false
      state.user = []
      state.assistant = ''
      state.tools = new Set()
      return
    }

    if (event.type === 'user/message') {
      const state = this.stateOf(session)
      const source = event.data?.source
      const text = extractText(event.data?.content)
      if (text.length > 0) state.lastUserText = text
      if (source?.kind === 'user') {
        if (text.trim().length > 0) state.user.push(text)
        return
      }
      if (typeof source?.kind === 'string' && source.kind.startsWith('dsh-memory')) {
        state.skip = true
      }
      return
    }

    if (event.type === 'assistant/message') {
      const state = this.stateOf(session)
      const message = event.data?.message
      const text = extractText(message?.content)
      if (text.trim().length > 0) state.assistant = text
      for (const name of extractToolNames(message?.content)) state.tools.add(name)
      return
    }

    if (event.type === 'turn/end') {
      const state = this.stateOf(session)
      state.open = false
      if (Number.isInteger(event.data?.turn)) state.turn = event.data.turn
      if (!this.shouldWrite(state)) return
      const snapshot = {
        turn: state.turn,
        user: [...state.user],
        assistant: state.assistant,
        tools: [...state.tools],
      }
      this.enqueue(() => this.writeEntry(session, snapshot))
      state.user = []
      state.assistant = ''
      state.tools = new Set()
    }
  }

  /** The latest direct user text observed for one session. */
  lastUserText(session) {
    return this.states.get(session)?.lastUserText ?? ''
  }

  /** Force-write the currently open turn, or the most recent completed one. */
  async flushSession(session) {
    if (!this.config.captureEnabled) return null
    const state = this.stateOf(session)
    if (!this.shouldWrite(state)) {
      await this.drain()
      return this.lastSaved.get(String(session.id ?? '')) ?? null
    }
    const snapshot = {
      turn: state.turn,
      user: [...state.user],
      assistant: state.assistant,
      tools: [...state.tools],
    }
    const task = this.enqueue(() => this.writeEntry(session, snapshot))
    const path = await task
    state.user = []
    state.assistant = ''
    state.tools = new Set()
    return path
  }

  /** Wait for all queued writes. */
  async drain() {
    await this.queue.catch(() => {})
  }

  stateOf(session) {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        turn: 0,
        open: false,
        skip: false,
        user: [],
        assistant: '',
        tools: new Set(),
        lastUserText: '',
      }
      this.states.set(session, state)
    }
    return state
  }

  shouldWrite(state) {
    if (state.skip && state.user.length === 0) return false
    const userText = state.user.join('\n\n')
    const assistantText = state.assistant
    if (userText.trim().length === 0 && assistantText.trim().length === 0) return false
    const total = userText.length + assistantText.length
    if (total < this.config.captureMinTurnChars && state.tools.size === 0) return false
    return true
  }

  enqueue(task) {
    const run = this.queue.then(task).catch((error) => {
      this.logger.warn?.('dsh-memory: session capture failed:', error)
      return null
    })
    this.queue = run.then(() => {})
    return run
  }

  async writeEntry(session, snapshot) {
    const resolved = await this.resolveStore(session)
    if (resolved === null) return null
    const { store } = resolved
    const sessionId = String(session.id ?? '')
    const sid8 = sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'session'
    const title = truncateText(firstLine(snapshot.user[0] ?? '') || `Session ${sid8}`, 100)
    const slug = slugify(title, 40) || 'session'
    let record = this.files.get(sessionId)

    if (record === undefined) {
      const existing = await store.listFiles({
        scopes: 'workspace',
        kinds: ['session'],
        maxFiles: this.config.searchMaxFiles,
      })
      const pattern = new RegExp(`-${escapeRegExp(sid8)}(?:-part(\\d+))?\\.md$`)
      const matches = existing.filter((file) => pattern.test(file.path))
      if (matches.length > 0) {
        matches.sort((left, right) => partOfPath(left.path) - partOfPath(right.path) || left.path.localeCompare(right.path))
        const seen = new Set()
        for (const file of matches) {
          const doc = await store.readDocument(file.absolutePath)
          for (const turn of parseTurnMarkers(doc?.content ?? '')) seen.add(turn)
        }
        const base = matches[0]
        const current = matches[matches.length - 1]
        record = {
          basePath: base.path,
          baseAbsolutePath: base.absolutePath,
          path: current.path,
          absolutePath: current.absolutePath,
          seen,
          title,
          part: partOfPath(current.path),
        }
      } else {
        await store.ensureScope('workspace')
        const dir = `${store.scopePrefix('workspace')}/sessions`
        const relPath = `${dir}/${dateStamp()}-${slug}-${sid8}.md`
        record = {
          basePath: relPath,
          baseAbsolutePath: storeScopePath(store, relPath),
          path: relPath,
          absolutePath: storeScopePath(store, relPath),
          seen: new Set(),
          title,
          part: 1,
        }
      }
      this.files.set(sessionId, record)
    }

    if (record.seen.has(snapshot.turn)) return record.absolutePath

    let part = record.part
    let absolutePath = partAbsolutePath(record, part)
    let info = await statSafe(absolutePath)
    while (info !== null && info.size > this.config.captureMaxFileBytes) {
      part += 1
      absolutePath = partAbsolutePath(record, part)
      info = await statSafe(absolutePath)
    }
    record.part = part
    record.absolutePath = absolutePath
    record.path = partPath(record, part)

    await ensureDir(dirname(absolutePath))
    const isNew = info === null || info.size === 0
    const entry = renderTurnEntry(snapshot, this.config)
    const prefix = isNew ? renderSessionHeader(session, title) : ''
    await appendText(absolutePath, `${prefix}${entry}`)
    record.seen.add(snapshot.turn)
    this.lastSaved.set(sessionId, absolutePath)
    return absolutePath
  }
}

/** Extract text blocks from model content. */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Collect tool names from assistant tool-call blocks. */
export function extractToolNames(content) {
  const names = []
  if (!Array.isArray(content)) return names
  for (const block of content) {
    if (block?.type === 'tool-call' && typeof block.name === 'string') names.push(block.name)
  }
  return names
}

/** Render one turn section. */
export function renderTurnEntry(snapshot, config) {
  const lines = [
    `<!-- dsh-memory turn=${snapshot.turn} -->`,
    `## Turn ${snapshot.turn} — ${isoNow()}`,
    '',
  ]
  const userText = snapshot.user.join('\n\n').trim()
  if (userText.length > 0) {
    lines.push('**User**', '', truncateText(userText, config.captureMaxUserChars), '')
  }
  if (snapshot.assistant.trim().length > 0) {
    lines.push('**Assistant**', '', truncateText(snapshot.assistant.trim(), config.captureMaxAssistantChars), '')
  }
  if (snapshot.tools.length > 0) {
    const unique = [...new Set(snapshot.tools)]
    lines.push(`**Tools:** ${unique.map((name) => `\`${name}\``).join(', ')}`, '')
  }
  let entry = `${lines.join('\n')}\n`
  if (entry.length > config.captureMaxEntryChars) {
    entry = `${truncateText(entry, config.captureMaxEntryChars, '\n… (turn truncated)')}\n`
  }
  return entry
}

/** Render the frontmatter for a new session log. */
export function renderSessionHeader(session, title) {
  const cwd = session?.header?.cwd ?? ''
  return [
    '---',
    'type: "session-log"',
    `session: ${JSON.stringify(String(session?.id ?? ''))}`,
    `created: ${JSON.stringify(isoNow())}`,
    `cwd: ${JSON.stringify(String(cwd))}`,
    `title: ${JSON.stringify(String(title))}`,
    '---',
    '',
  ].join('\n')
}

/** Parse dedup markers from an existing session log. */
export function parseTurnMarkers(content) {
  const seen = new Set()
  const pattern = /<!--\s*dsh-memory\s+turn=(\d+)\s*-->/g
  let match
  while ((match = pattern.exec(String(content ?? ''))) !== null) {
    seen.add(Number(match[1]))
  }
  return seen
}

function isSubagent(session) {
  return session?.header?.parentSession !== undefined && session?.header?.parentSession !== null
}

function storeScopePath(store, relPath) {
  return resolve(store.root, ...relPath.split('/'))
}

function partAbsolutePath(record, part) {
  return part <= 1 ? record.baseAbsolutePath : record.baseAbsolutePath.replace(/\.md$/i, `-part${part}.md`)
}

function partPath(record, part) {
  return part <= 1 ? record.basePath : record.basePath.replace(/\.md$/i, `-part${part}.md`)
}

function partOfPath(path) {
  const match = String(path).match(/-part(\d+)\.md$/i)
  return match ? Number(match[1]) : 1
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
