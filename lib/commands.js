/**
 * Human-facing slash commands for dsh-memory.
 *
 * Commands run directly against the receiving agent without adding a model
 * message, except `/dream`, which queues an explicit consolidation turn.
 *
 * @module dsh-memory/commands
 */

import { basename, relative, sep } from 'node:path'
import { createMemoryMessage } from './runtime.js'
import { renderSearchResults } from './tools.js'

const MEMORY_USAGE =
  'Usage: /memory [list|search <query>|show <path>|flush|clear <workspace|global|all> --yes|help]'
const REMEMBER_USAGE =
  'Usage: /remember [--global] [--topic <name>] <text>'
const FORGET_USAGE =
  'Usage: /forget [--global|--workspace|--all] [--path <path>|<query>]'
const DREAM_PROMPT = [
  'Consolidate persistent memory for this workspace now.',
  '',
  'Steps:',
  '1. Call `memory_list` to see topics, pending observations, and recent session logs.',
  '2. Call `memory_search` with a few broad queries to inspect the recent session logs and observations that matter.',
  '3. Merge durable facts into focused topic files with `memory_remember({ topic, text, scope })`. Keep project-specific knowledge in scope `workspace`; keep cross-project user preferences in scope `global`. Resolve contradictions in favor of current evidence, convert relative dates to absolute dates, and remove duplication.',
  '4. After a fact is safely saved, remove its superseded observation or redundant topic block with `memory_forget`. Do not delete session logs.',
  '',
  'Rules: never store secrets, credentials, tokens, transient task state, speculative conclusions, or facts likely to become stale. Preserve decisions, rationale, architecture, conventions, and recurring workflows. If there is nothing worth consolidating, say so and make no changes.',
  '',
  'Report briefly what you consolidated.',
].join('\n')

/** Register the command surface when the commands service is mounted. */
export function registerCommands(ctx, runtime) {
  if (!runtime.config.commandsEnabled) return
  const commands = ctx.get('commands')
  if (commands === undefined || commands === null) {
    runtime.logger.debug?.('dsh-memory: commands service is not mounted; slash commands are unavailable')
    return
  }
  for (const definition of createCommandDefinitions(runtime)) {
    ctx.effect(() => commands.register(definition), `dsh-memory.command.${definition.name}`)
  }
}

/** Build command definitions for tests and registration. */
export function createCommandDefinitions(runtime) {
  return [
    {
      name: 'memory',
      description: 'Browse, search, save, flush, or clear persistent memory',
      input: { hint: '[list|search <query>|show <path>|flush|clear <scope> --yes|help]' },
      handler: (invocation) => handleMemoryCommand(runtime, invocation),
    },
    {
      name: 'remember',
      description: 'Save a durable note to persistent memory',
      input: { hint: '[--global] [--topic <name>] <text>' },
      handler: (invocation) => handleRememberCommand(runtime, invocation),
    },
    {
      name: 'forget',
      description: 'Remove a memory note by path or text match',
      input: { hint: '[--global|--workspace|--all] [--path <path>|<query>]' },
      handler: (invocation) => handleForgetCommand(runtime, invocation),
    },
    {
      name: 'dream',
      description: 'Consolidate session logs and observations into topic notes',
      handler: (invocation) => handleDreamCommand(runtime, invocation),
    },
    {
      name: 'flush',
      description: 'Save the current session transcript to memory now',
      handler: (invocation) => handleFlushCommand(runtime, invocation),
    },
  ]
}

async function handleMemoryCommand(runtime, invocation) {
  const input = String(invocation.rawInput ?? '').trim()
  const [subcommand = 'list', ...rest] = input.length === 0 ? [] : input.split(/\s+/)
  const tail = rest.join(' ').trim()

  try {
    if (subcommand === 'help') return { kind: 'success', text: MEMORY_USAGE }
    if (subcommand === 'list') return await renderList(runtime, invocation)
    if (subcommand === 'search') {
      if (tail.length === 0) return { kind: 'error', text: `A search query is required.\n${MEMORY_USAGE}` }
      return await renderSearch(runtime, invocation, tail)
    }
    if (subcommand === 'show') {
      if (tail.length === 0) return { kind: 'error', text: `A memory path is required.\n${MEMORY_USAGE}` }
      return await renderShow(runtime, invocation, tail)
    }
    if (subcommand === 'flush') return await handleFlushCommand(runtime, invocation)
    if (subcommand === 'clear') return await handleClear(runtime, invocation, rest)
    return { kind: 'error', text: `Unknown /memory subcommand "${subcommand}".\n${MEMORY_USAGE}` }
  } catch (error) {
    return { kind: 'error', text: `Memory command failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function renderList(runtime, invocation) {
  const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
  const stats = await store.stats()
  if (stats.scopes.length === 0) {
    return { kind: 'error', text: 'Memory scopes are disabled for this session.' }
  }

  const lines = ['Memory is enabled.', `Root: ${store.config.memoryRootDisplay}`, '']
  for (const scope of stats.scopes) {
    lines.push(
      `${scope.scope === 'global' ? 'Global' : 'Workspace'} (\`${scope.prefix}/\`): ` +
        `${scope.counts.topic} topic(s), ${scope.counts.observation} observation(s), ${scope.counts.session} session log(s)`,
    )
  }

  const topics = stats.scopes.flatMap((scope) => scope.topics.map((topic) => ({ ...topic, scope: scope.scope })))
  if (topics.length > 0) {
    lines.push('', 'Recent topics:')
    for (const topic of topics.slice(0, 8)) {
      lines.push(`- **${topic.title || basename(topic.path)}** — \`${topic.path}\``)
    }
  }

  const sessions = stats.scopes
    .flatMap((scope) => scope.files.filter((file) => file.kind === 'session'))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 5)
  if (sessions.length > 0) {
    lines.push('', 'Recent session logs:')
    for (const session of sessions) {
      const date = new Date(session.mtimeMs).toISOString().slice(0, 10)
      lines.push(`- ${date} — \`${session.path}\``)
    }
  }

  lines.push('', 'Commands: /remember · /forget · /memory search <query> · /memory show <path> · /memory flush · /dream · /memory clear <scope> --yes')
  return { kind: 'success', text: lines.join('\n') }
}

async function renderSearch(runtime, invocation, query) {
  const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
  const result = await store.search({ query, maxResults: 8, minScore: 0.4 })
  return {
    kind: 'success',
    text: renderSearchResults(
      {
        query: result.query,
        total: result.total,
        results: result.results.map((entry) => ({
          path: entry.path,
          source: entry.source,
          score: entry.score,
          title: entry.title,
          snippet: entry.snippet,
          start_line: entry.startLine,
          end_line: entry.endLine,
          age_days: entry.ageDays,
        })),
      },
      store.config,
    ),
  }
}

async function renderShow(runtime, invocation, path) {
  const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
  const result = await store.read({ path })
  return {
    kind: 'success',
    text: [
      `**File:** ${result.path}`,
      `**Lines:** ${result.start_line}-${result.end_line} of ${result.total_lines}${result.truncated ? ' (truncated)' : ''}`,
      '',
      result.content,
    ].join('\n'),
  }
}

async function handleClear(runtime, invocation, tokens) {
  const scopes = tokens.filter((token) => ['workspace', 'global', 'all'].includes(token))
  const confirmed = tokens.includes('--yes') || tokens.includes('-y')
  const scope = scopes[0] ?? 'workspace'
  if (!confirmed) {
    return {
      kind: 'error',
      text: `Clearing memory is destructive. Re-run with --yes: /memory clear ${scope} --yes`,
    }
  }
  const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
  const result = await store.clear(scope)
  if (result.removed.length === 0) {
    return { kind: 'success', text: `No ${scope} memory to clear.` }
  }
  return { kind: 'success', text: `Cleared: ${result.removed.join(', ')}` }
}

async function handleRememberCommand(runtime, invocation) {
  const parsed = parseRememberInput(invocation.rawInput)
  if (parsed.kind === 'help') return { kind: 'success', text: REMEMBER_USAGE }
  if (parsed.kind === 'error') return { kind: 'error', text: `${parsed.reason}\n${REMEMBER_USAGE}` }
  try {
    const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
    const result = await store.remember({
      text: parsed.text,
      scope: parsed.scope,
      topic: parsed.topic,
    })
    return {
      kind: 'success',
      text: result.created ? `Memory saved to ${result.path}` : `Already saved in ${result.path}`,
    }
  } catch (error) {
    return { kind: 'error', text: `Could not save memory: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function handleForgetCommand(runtime, invocation) {
  const parsed = parseForgetInput(invocation.rawInput)
  if (parsed.kind === 'help') return { kind: 'success', text: FORGET_USAGE }
  if (parsed.kind === 'error') return { kind: 'error', text: `${parsed.reason}\n${FORGET_USAGE}` }
  try {
    const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
    const result = await store.forget({
      path: parsed.path,
      query: parsed.query,
      scope: parsed.scope,
    })
    if (result.count === 0) return { kind: 'success', text: 'No matching memory was removed.' }
    return {
      kind: 'success',
      text: [`Removed ${result.count} memory entr${result.count === 1 ? 'y' : 'ies'}:`, ...result.removed.map((entry) => `- ${entry.path} — ${entry.detail}`)].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: `Could not forget memory: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function handleFlushCommand(runtime, invocation) {
  try {
    const { store } = await runtime.storeForAgent(invocation.agent, invocation.signal)
    const absolute = await runtime.capture.flushSession(invocation.agent.session)
    if (absolute === null) return { kind: 'success', text: 'Nothing new to save in this session.' }
    const rel = relative(store.root, absolute).split(sep).join('/')
    return { kind: 'success', text: `Session transcript saved to ${rel}` }
  } catch (error) {
    return { kind: 'error', text: `Could not flush memory: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function handleDreamCommand(runtime, invocation) {
  try {
    const message = createMemoryMessage(DREAM_PROMPT, { form: 'dream' })
    invocation.agent.followup(message)
    return {
      kind: 'success',
      text: 'Memory consolidation started. The agent is reviewing session logs and observations and will merge durable facts into topics.',
    }
  } catch (error) {
    return { kind: 'error', text: `Could not start memory consolidation: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Parse `/remember` input.
 *
 * @param {string} raw
 * @returns {{kind:'remember',scope:'workspace'|'global',topic:string|undefined,text:string}|{kind:'help'}|{kind:'error',reason:string}}
 */
export function parseRememberInput(raw) {
  const input = String(raw ?? '').trim()
  if (input.length === 0 || input === '--help' || input === '-h' || input === 'help') return { kind: 'help' }

  let scope = 'workspace'
  let topic
  const words = input.split(/\s+/)
  const textWords = []
  let index = 0

  while (index < words.length) {
    const word = words[index]
    if (word === '--global' || word === '-g') {
      scope = 'global'
      index += 1
      continue
    }
    if (word === '--workspace') {
      scope = 'workspace'
      index += 1
      continue
    }
    if (word === '--help' || word === '-h') return { kind: 'help' }
    if (word === '--') {
      textWords.push(...words.slice(index + 1))
      break
    }
    if (word.startsWith('--topic=')) {
      topic = word.slice('--topic='.length).trim()
      if (topic.length === 0) return { kind: 'error', reason: '--topic requires a non-empty name' }
      index += 1
      continue
    }
    if (word === '--topic' || word === '-t') {
      topic = words[index + 1]?.trim()
      if (topic === undefined || topic.length === 0) return { kind: 'error', reason: '--topic requires a name' }
      index += 2
      continue
    }
    textWords.push(word)
    index += 1
  }

  const text = textWords.join(' ').trim()
  if (text.length === 0) return { kind: 'error', reason: 'A note is required.' }
  return { kind: 'remember', scope, topic, text }
}

/**
 * Parse `/forget` input.
 *
 * @param {string} raw
 * @returns {{kind:'forget',scope:'all'|'workspace'|'global',path?:string,query?:string}|{kind:'help'}|{kind:'error',reason:string}}
 */
export function parseForgetInput(raw) {
  const input = String(raw ?? '').trim()
  if (input.length === 0 || input === '--help' || input === '-h' || input === 'help') return { kind: 'help' }

  let scope = 'all'
  let path
  const queryWords = []
  const words = input.split(/\s+/)
  let index = 0

  while (index < words.length) {
    const word = words[index]
    if (word === '--global') {
      scope = 'global'
      index += 1
      continue
    }
    if (word === '--workspace') {
      scope = 'workspace'
      index += 1
      continue
    }
    if (word === '--all') {
      scope = 'all'
      index += 1
      continue
    }
    if (word === '--help' || word === '-h') return { kind: 'help' }
    if (word.startsWith('--path=')) {
      path = word.slice('--path='.length).trim()
      if (path.length === 0) return { kind: 'error', reason: '--path requires a memory file path' }
      index += 1
      continue
    }
    if (word === '--path') {
      path = words[index + 1]?.trim()
      if (path === undefined || path.length === 0) return { kind: 'error', reason: '--path requires a memory file path' }
      index += 2
      continue
    }
    queryWords.push(word)
    index += 1
  }

  if (path !== undefined && queryWords.length > 0) {
    return { kind: 'error', reason: 'Pass a path or a query, not both.' }
  }
  if (path === undefined && queryWords.length === 0) {
    return { kind: 'error', reason: 'Pass a path (--path) or a query.' }
  }
  return {
    kind: 'forget',
    scope,
    ...(path === undefined ? { query: queryWords.join(' ') } : { path }),
  }
}

