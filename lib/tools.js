/**
 * Model-facing memory tools.
 *
 * Definitions use raw JSON Schema (the supported subset) so the plugin needs no
 * import from the Harness packages. Every tool requires an owning agent session
 * because memory scopes are derived from that session's working directory.
 *
 * @module dsh-memory/tools
 */

import { basename } from 'node:path'
import { collapseWhitespace, truncateText } from './text.js'

const TOOL_NAMES = ['memory_search', 'memory_get', 'memory_list', 'memory_remember', 'memory_forget']

/** Register every memory tool as an owned effect. */
export function registerTools(ctx, runtime) {
  if (!runtime.config.toolsEnabled) return
  for (const definition of createToolDefinitions(runtime)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-memory.tool.${definition.name}`)
  }
}

/** Build the model-facing tool definitions. */
export function createToolDefinitions(runtime) {
  const search = {
    name: 'memory_search',
    description:
      'Search persistent cross-session memory for relevant knowledge chunks. Returns ranked results from global memory, workspace memory, and past session logs.\n\n' +
      'Use this proactively when a request references prior work, decisions, or context you do not have; when you need project conventions, coding patterns, or user preferences; when the user mentions something discussed or decided in a previous session; when starting work in an unfamiliar part of the codebase; or after compaction when prior context may have been lost.\n\n' +
      'Memory is historical context, not automatically the current plan. Verify recalled facts against live sources before relying on them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Use specific technical terms rather than conversational language: "authentication middleware patterns" instead of "that thing we discussed".',
        },
        scope: {
          type: 'string',
          enum: ['all', 'workspace', 'global'],
          description: 'Which memory scopes to search. Default: all.',
        },
        source: {
          type: 'string',
          enum: ['all', 'workspace', 'global', 'session'],
          description: 'Restrict matches to one source kind. Default: all.',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum number of results (1-50). Defaults to the configured value, normally 6.',
        },
        min_score: {
          type: 'number',
          description: 'Minimum normalized relevance score (0-1). Defaults to the configured value.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'total', 'results'],
        properties: {
          query: { type: 'string' },
          total: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'source', 'score', 'title', 'snippet', 'start_line', 'end_line'],
              properties: {
                path: { type: 'string' },
                source: { type: 'string' },
                score: { type: 'number' },
                title: { type: 'string' },
                snippet: { type: 'string' },
                start_line: { type: 'integer' },
                end_line: { type: 'integer' },
                age_days: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResults(value, runtime.config) }],
    },
    async execute(args, exec) {
      const store = await storeOf(runtime, exec)
      const result = await store.search({
        query: args.query,
        scope: args.scope,
        source: args.source,
        maxResults: args.max_results,
        minScore: args.min_score,
      })
      return {
        query: result.query,
        total: result.total,
        results: result.results.map((entry) => ({
          path: entry.path,
          source: entry.source,
          score: Number(entry.score.toFixed(4)),
          title: entry.title,
          snippet: entry.snippet,
          start_line: entry.startLine,
          end_line: entry.endLine,
          age_days: Number(entry.ageDays.toFixed(1)),
        })),
      }
    },
  }

  const get = {
    name: 'memory_get',
    description:
      'Read a memory file by path. Returns the file content with 1-based line numbers, optionally limited to a line range.\n\n' +
      'Use after memory_search returns a relevant result and you need the full context around a snippet, or to read a specific MEMORY.md or topic file. Paths are the root-relative paths memory_search returns. Memory is historical context; verify changeable facts before relying on them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Memory-root-relative path such as `workspaces/my-repo-1a2b3c4d/topics/auth.md`.' },
        from: { type: 'integer', description: '1-based first line to return. Default: 1.' },
        lines: { type: 'integer', description: 'Maximum number of lines to return. Default: all (bounded to 2000).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content', 'total_lines', 'start_line', 'end_line', 'truncated'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          total_lines: { type: 'integer' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `**File:** ${value.path}`,
            `**Lines:** ${value.start_line}-${value.end_line} of ${value.total_lines}${value.truncated ? ' (truncated)' : ''}`,
            '',
            value.content,
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const store = await storeOf(runtime, exec)
      return store.read({ path: args.path, from: args.from, lines: args.lines })
    },
  }

  const list = {
    name: 'memory_list',
    description:
      'List saved memory files with their titles, sizes, and dates. Use it to browse what exists before consolidating or forgetting notes, or to find a file path for memory_get. Prefer memory_search when you need content rather than an inventory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['all', 'workspace', 'global'], description: 'Which scopes to list. Default: all.' },
        kind: {
          type: 'string',
          enum: ['all', 'index', 'topic', 'observation', 'session'],
          description: 'Restrict to one file kind. Default: all.',
        },
        max_files: { type: 'integer', description: 'Maximum number of files to return (1-200). Default: 100.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['root', 'total', 'files'],
        properties: {
          root: { type: 'string' },
          total: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'scope', 'kind', 'title', 'bytes', 'modified'],
              properties: {
                path: { type: 'string' },
                scope: { type: 'string' },
                kind: { type: 'string' },
                title: { type: 'string' },
                bytes: { type: 'integer' },
                modified: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderFileList(value) }],
    },
    async execute(args, exec) {
      const store = await storeOf(runtime, exec)
      const scopes = args.scope ?? 'all'
      const kinds = args.kind ?? 'all'
      const maxFiles = clampInteger(args.max_files ?? 100, 1, 200, 100)
      const files = await store.listFiles({ scopes, kinds, readTitle: true, maxFiles })
      return {
        root: store.config.memoryRootDisplay,
        total: files.length,
        files: files.map((file) => ({
          path: file.path,
          scope: file.scope,
          kind: file.kind,
          title: file.title || basename(file.path),
          bytes: file.size,
          modified: new Date(file.mtimeMs).toISOString(),
        })),
      }
    },
  }

  const remember = {
    name: 'memory_remember',
    description:
      'Save a durable fact to persistent cross-session memory. Use scope `workspace` for project-specific conventions, decisions, architecture, and workflows; use scope `global` for cross-project user preferences. Provide a `topic` to keep related notes together in one Markdown file; omit it for a standalone observation. Never store secrets, credentials, tokens, transient task state, or speculative conclusions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The fact to remember. Write it as a self-contained, durable statement with enough context to be useful in a future session.',
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'Memory scope. Default: workspace.',
        },
        topic: {
          type: 'string',
          description: 'Optional topic name, for example "auth" or "build-and-test". Related notes append to the same topic file.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'scope', 'created'],
        properties: {
          path: { type: 'string' },
          scope: { type: 'string' },
          topic: { type: 'string' },
          created: { type: 'boolean' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.created ? `Saved to ${value.path}` : `Already saved in ${value.path}`,
        },
      ],
    },
    async execute(args, exec) {
      const store = await storeOf(runtime, exec)
      const result = await store.remember({ text: args.text, scope: args.scope, topic: args.topic })
      return {
        path: result.path,
        scope: result.scope,
        topic: result.topic ?? '',
        created: result.created,
      }
    },
  }

  const forget = {
    name: 'memory_forget',
    description:
      'Remove saved memory. Pass `path` to delete exactly one topic, observation, or session file. Pass `query` to remove matching notes from topic and observation files (best-effort; session logs are never removed by a query). Prefer `path` when the user asks for guaranteed removal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Memory-root-relative file path to delete.' },
        query: { type: 'string', description: 'Best-effort text match for notes to remove from topic/observation files.' },
        scope: {
          type: 'string',
          enum: ['all', 'workspace', 'global'],
          description: 'Scopes to search when using `query`. Default: all.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'removed'],
        properties: {
          count: { type: 'integer' },
          removed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'detail'],
              properties: {
                path: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.count === 0
              ? 'No matching memory was removed.'
              : [`Removed ${value.count} memory entr${value.count === 1 ? 'y' : 'ies'}:`, ...value.removed.map((entry) => `- ${entry.path} — ${entry.detail}`)].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' && typeof args.query !== 'string') {
        throw new Error('memory_forget requires either `path` or `query`')
      }
      if (typeof args.path === 'string' && typeof args.query === 'string') {
        throw new Error('memory_forget accepts `path` or `query`, not both')
      }
      const store = await storeOf(runtime, exec)
      const result = await store.forget({ path: args.path, query: args.query, scope: args.scope })
      return {
        count: result.count,
        removed: result.removed.map((entry) => ({ path: entry.path, detail: entry.detail })),
      }
    },
  }

  return [search, get, list, remember, forget]
}

/** Render search results in the shape Grok Build's memory tool uses. */
export function renderSearchResults(value, config) {
  if (value.total === 0) return 'No matching memory found.'
  const lines = [`Found ${value.total} memory result${value.total === 1 ? '' : 's'}:`]
  value.results.forEach((result, index) => {
    lines.push('')
    lines.push(`### Result ${index + 1} (score: ${result.score.toFixed(2)}, source: ${result.source})`)
    lines.push(`**File:** ${result.path} (lines ${result.start_line}-${result.end_line})`)
    if (result.title) lines.push(`**Title:** ${result.title}`)
    if (
      result.source === 'session' &&
      typeof result.age_days === 'number' &&
      result.age_days > (config.searchStalenessDays ?? 7)
    ) {
      lines.push(
        `*This session memory is ${Math.round(result.age_days)} day(s) old; verify current state before relying on it.*`,
      )
    }
    lines.push('')
    lines.push(result.snippet)
  })
  return lines.join('\n')
}

/** Render the file inventory. */
export function renderFileList(value) {
  if (value.total === 0) return `No memory files found under ${value.root}.`
  const lines = [`Memory root: ${value.root} (${value.total} file${value.total === 1 ? '' : 's'})`]
  let currentGroup = ''
  for (const file of value.files) {
    const group = `${file.scope}/${file.kind}`
    if (group !== currentGroup) {
      currentGroup = group
      lines.push('', `### ${file.scope} — ${file.kind}s`)
    }
    const title = truncateText(collapseWhitespace(file.title) || basename(file.path), 90)
    lines.push(`- **${title}** — \`${file.path}\` (${formatBytes(file.bytes)}, ${file.modified.slice(0, 10)})`)
  }
  return lines.join('\n')
}

async function storeOf(runtime, exec) {
  if (exec?.agent === undefined || exec?.agent === null) {
    throw new Error('memory tools require an owning agent session')
  }
  const { store } = await runtime.storeForAgent(exec.agent, exec.signal)
  return store
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Names reserved by this plugin. */
export const MEMORY_TOOL_NAMES = TOOL_NAMES

