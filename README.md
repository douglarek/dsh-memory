# dsh-memory

Cross-session persistent memory for DeepSeek Harness (DSH), modeled on Grok
Build's memory implementation.

The plugin keeps durable, human-editable Markdown notes in two scopes — global
(preferences shared by every project) and workspace (one repository) — captures
completed turns into searchable session logs, injects a bounded memory index on
the first turn, and gives the model five memory tools plus five slash commands.

It is a Host-only bundle with no runtime dependencies beyond Node built-ins. It
contains no UI panel; memory is browsed through the tools and `/memory`.

## Install

### For agents

This is a DSH Host plugin bundle; it is not installed with `npm install`.
Choose the first usable path:

1. `plugin_manager` tool available:

```text
plugin_manager { action: "install_bundle", target: "github:douglarek/dsh-memory" }
```

2. `DSH_PROFILE` is `desktop`: install from the Plugin Manager in the running
   DSH app.

3. Another profile:

```bash
dsh plugin --profile "$DSH_PROFILE" add github:douglarek/dsh-memory
```

If `DSH_PROFILE` is unset, ask the user for the profile name.

4. Local checkout:

```text
plugin_manager { action: "install_bundle", target: "/absolute/path/to/dsh-memory" }
```

Do not edit the profile's `package.json` or `cordis.patch.yml` by hand, and do
not run pnpm in the profile directory.

Verify with `memory_list`. If the memory tools are unavailable, start a new
session or restart DSH.

### DSH Plugin Manager

```text
plugin_manager { action: "install_bundle", target: "github:douglarek/dsh-memory" }
```

### CLI

The `desktop` profile is managed by the Electron application. For another profile:

```bash
dsh plugin --profile my-profile add github:douglarek/dsh-memory
```

Remove it with:

```bash
dsh plugin --profile my-profile remove dsh-memory
```

### Local checkout

```text
plugin_manager { action: "install_bundle", target: "/absolute/path/to/dsh-memory" }
```

`package.json` declares `dsh.bundle.patch`; `cordis.patch.yml` inserts the
`dsh-memory` Host row.

### Manual profile row

```yaml
- insert:
    - id: dsh-memory
      name: 'dsh-memory'
      config:
        enabled: true
```

The package must be resolvable from the profile's `node_modules`.

---

## What it does

| Capability | Behavior |
|---|---|
| Scoped notes | `global/` and `workspaces/<slug>-<hash8>/` under `$DSH_HOME/memory/` |
| Curated memory | `topics/<topic>.md` and `observations/_inbox/*.md` |
| Generated index | `MEMORY.md` per scope, rebuilt after every write |
| Session capture | Each completed turn appended to a per-session Markdown log |
| First-turn injection | A compact index is injected once as a durable user-role message |
| Post-compaction refresh | A compact index is re-injected after `compaction/end` |
| Model tools | `memory_search`, `memory_get`, `memory_list`, `memory_remember`, `memory_forget` |
| Human commands | `/memory`, `/remember`, `/forget`, `/dream`, `/flush` |
| Search | BM25 full-text with temporal decay, source weights, and optional MMR |
| Chinese search | CJK unigrams + bigrams, so Chinese notes match without a segmenter |
| Prompt guidance | A `<memory>` section explains when and how to use the tools |

The implementation follows Grok Build's memory model:

- Memory is Markdown on disk, readable and editable by the user; the next search
  sees the change.
- `MEMORY.md` is a generated index of topics and observations.
- Workspace identity comes from the git `origin` remote when available,
  otherwise from the canonical project directory.
- Search is BM25 full-text with normalized scores, session-chunk temporal decay,
  source weights, and optional MMR.
- Session memory is historical context; verify changeable facts against live
  sources.

---

## Configure

All options are optional and have code defaults. The bundle row starts with the
most important defaults; edit the row's `config` in your profile patch.

```yaml
- id: dsh-memory
  name: 'dsh-memory'
  config:
    enabled: true
    memoryDir: ''                 # default: $DSH_HOME/memory
    scopeGlobal: true
    scopeWorkspace: true
    toolsEnabled: true
    promptEnabled: true
    commandsEnabled: true
    captureEnabled: true
    injectEnabled: true
```

A patch that targets an existing row replaces its whole `config`; restate every
field you need.

### Core

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; false registers nothing. |
| `memoryDir` | `''` | Memory root. Empty means `$DSH_HOME/memory`; `~` expands. |
| `scopeGlobal` | `true` | Enable the global scope. |
| `scopeWorkspace` | `true` | Enable the workspace scope. |
| `toolsEnabled` | `true` | Register the five memory tools. |
| `promptEnabled` | `true` | Add the `<memory>` system-prompt section. |
| `commandsEnabled` | `true` | Register slash commands when the commands service is mounted. |
| `promptInstructions` | `''` | Replace the default `<memory>` prompt section verbatim. |

### Capture

| Option | Default | Meaning |
|---|---|---|
| `captureEnabled` | `true` | Append completed turns to session logs. |
| `captureSubagents` | `false` | Capture subagent sessions too. |
| `captureMinTurnChars` | `24` | Skip turns shorter than this unless a tool ran. |
| `captureMaxUserChars` | `2000` | Per-turn user text cap. |
| `captureMaxAssistantChars` | `2000` | Per-turn assistant text cap. |
| `captureMaxEntryChars` | `6000` | Whole turn entry cap. |
| `captureMaxFileBytes` | `2000000` | Rotate a session log to `-partN.md` past this size. |

### Injection

| Option | Default | Meaning |
|---|---|---|
| `injectEnabled` | `true` | Inject the memory index at all. |
| `injectSubagents` | `false` | Inject into subagent sessions too. |
| `injectAlways` | `false` | Inject a short "memory is empty" notice when no notes exist. |
| `injectAfterCompaction` | `true` | Refresh the index after `compaction/end`. |
| `injectMaxBytes` | `4096` | Byte budget for the injected index. |
| `injectMaxTopics` | `40` | Topic entries per scope. |
| `injectMaxObservations` | `8` | Pending observation entries per scope. |
| `injectMaxSessions` | `8` | Recent session logs listed. |

### Search and index

| Option | Default | Meaning |
|---|---|---|
| `searchMaxResults` | `6` | Default result count. |
| `searchMinScore` | `0.7` | Default normalized score threshold. |
| `searchHalfLifeDays` | `30` | Session-chunk half-life; `0` disables decay. |
| `searchMmrEnabled` | `true` | Diversity re-ranking. |
| `searchMmrLambda` | `0.7` | MMR relevance/diversity balance. |
| `searchMaxFiles` | `2000` | File scan bound. |
| `searchMaxFileBytes` | `2000000` | Per-file read bound. |
| `searchMaxChunks` | `600` | Chunk index bound. |
| `searchStalenessDays` | `7` | Add a staleness note to older session results. |
| `searchIncludeIndex` | `false` | Also index the generated `MEMORY.md` (duplicates topics). |
| `searchSourceWeights` | `{global:1,workspace:1,session:1}` | Per-source score multipliers. |
| `chunkMaxChars` | `1600` | Chunk size. |
| `chunkOverlapChars` | `320` | Continuation overlap; at most half of `chunkMaxChars`. |
| `indexMaxBytes` | `8192` | Generated index size budget. |
| `indexMaxEntries` | `64` | Generated index entry budget. |
| `skipTemporaryWorkspaces` | `false` | Disable workspace memory for temp-directory sessions. |

Unknown options are ignored with a warning; invalid types and out-of-range
values fail activation with a clear error.

---

## Storage layout

```text
$DSH_HOME/memory/
├── global/
│   ├── MEMORY.md                     generated index (read-only for the model)
│   ├── topics/<topic>.md             curated notes, one subject per file
│   └── observations/_inbox/*.md      standalone observations
└── workspaces/<slug>-<hash8>/
    ├── MEMORY.md                     generated index
    ├── topics/<topic>.md
    ├── observations/_inbox/*.md
    ├── sessions/
    │   └── YYYY-MM-DD-<slug>-<sid8>.md
    └── .scope.json                   workspace identity metadata
```

Directories are created with mode `0700` and files with `0600`, subject to the
process umask. `MEMORY.md` is rebuilt atomically after every write.

### Workspace identity

`<slug>-<hash8>` is derived from the repository identity:

1. Read the `origin` URL from the project's git config (no `git` process is
   spawned). `git@github.com:org/repo.git` and HTTPS forms both normalize to
   `org/repo`.
2. Use `sha256(identity)`'s first 8 hex characters as the hash and the repo name
   as the slug.
3. Without an `origin` remote, use the canonical project directory itself.

Clones and worktrees of one repository therefore share a workspace scope.

---

## Tools

The model sees five tools. All require an owning agent session because the
workspace scope comes from that session's working directory.

### `memory_search`

Search global, workspace, and past-session chunks.

| Argument | Type | Meaning |
|---|---|---|
| `query` | string, required | Specific technical terms work best. |
| `scope` | `all` \| `workspace` \| `global` | Default `all`. |
| `source` | `all` \| `workspace` \| `global` \| `session` | Restrict by source kind. |
| `max_results` | integer | 1–50; defaults to `searchMaxResults`. |
| `min_score` | number | 0–1; defaults to `searchMinScore`. |

Results include root-relative paths, line ranges, source, score, title, snippet,
and age for session entries. Paths can be passed directly to `memory_get`.

### `memory_get`

Read a Markdown memory file with 1-based line numbers.

| Argument | Type | Meaning |
|---|---|---|
| `path` | string, required | Root-relative, absolute under the root, or `workspace/...` / `global/...` alias. |
| `from` | integer | 1-based first line. |
| `lines` | integer | Maximum lines (bounded to 2000). |

Path traversal and symlink escapes outside the memory root are rejected.

### `memory_list`

Inventory of saved files with titles, sizes, and dates.

| Argument | Type | Meaning |
|---|---|---|
| `scope` | `all` \| `workspace` \| `global` | Default `all`. |
| `kind` | `all` \| `index` \| `topic` \| `observation` \| `session` | Default `all`. |
| `max_files` | integer | 1–200; default 100. |

Useful before `/dream`, or to find a path for `memory_get` / `memory_forget`.

### `memory_remember`

Save a durable fact.

| Argument | Type | Meaning |
|---|---|---|
| `text` | string, required | Self-contained durable statement; max 8000 characters. |
| `scope` | `workspace` \| `global` | Default `workspace`. |
| `topic` | string | Optional topic name. Related notes append to one topic file. |

Without a topic, the note becomes a standalone observation file. Duplicate notes
in the same topic on the same day are suppressed.

### `memory_forget`

Remove memory.

| Argument | Type | Meaning |
|---|---|---|
| `path` | string | Delete exactly this topic, observation, or session file. |
| `query` | string | Best-effort removal of matching topic/observation lines. |
| `scope` | `all` \| `workspace` \| `global` | Scope for `query`. |

Pass exactly one of `path` or `query`. A path gives guaranteed removal; a query
never deletes session logs and may delete a topic file that becomes empty.

---

## Commands

Commands run directly against the receiving agent without creating a model
message, except `/dream`.

| Command | Behavior |
|---|---|
| `/memory` or `/memory list` | Show the root, per-scope counts, recent topics, and recent sessions. |
| `/memory search <query>` | Print ranked results. |
| `/memory show <path>` | Print a file with line numbers. |
| `/memory flush` | Save the current turn now. |
| `/memory clear <workspace\|global\|all> --yes` | Destructive clear; `--yes` is required. |
| `/remember [--global] [--topic <name>] <text>` | Save a note. |
| `/forget [--global\|--workspace\|--all] [--path <path>\|<query>]` | Remove memory. |
| `/dream` | Queue one explicit consolidation turn. |
| `/flush` | Save the session transcript now and report its path. |

`/dream` sends a normal user-role turn whose source is `dsh-memory`; that turn
asks the active model to use `memory_list`, `memory_search`, `memory_remember`,
and `memory_forget` to merge durable facts into topics. Automatic capture skips
these agent-assisted turns.

`/flush` writes an extractive transcript section.

---

## How injection works

On the first eligible `agent/pre-step`, the plugin builds a bounded index from
the global and workspace scopes plus recent session titles, wraps it in
`<memory-context>`, and inserts it after the claimed user messages as a durable
user-role message with:

```json
{ "kind": "dsh-memory", "form": "baseline", "workspace": "<scope dir>" }
```

The message is an ordinary sourced `user/message`, so it replays, resumes, forks,
and compacts exactly like other history. The plugin scans the session surface to
avoid injecting the baseline twice, including after a resume.

After `compaction/end`, the next eligible step receives a smaller `form:
"refresh"` index. Both forms are bounded by `injectMaxBytes`.

Subagent sessions do not receive the baseline by default; the tools remain
available to them.

---

## Search details

- **Tokenizer.** Lowercase NFKC; Latin/digit/underscore runs become words; CJK
  runs produce unigrams and bigrams; query stop words are removed.
- **Chunking.** Markdown headings and paragraph boundaries, with a continuation
  overlap, inclusive line ranges, and bounded line splitting for huge lines.
- **BM25.** `k1 = 1.2`, `b = 0.75`, raw scores min-max normalized to `[0,1]`.
  A single candidate receives 1.0.
- **Temporal decay.** Only `session` chunks decay:
  `exp(-(ln 2 / halfLifeDays) * ageDays)`. Global and workspace memory are
  evergreen.
- **Source weights.** Multipliers from `searchSourceWeights`.
- **Threshold.** Results below `minScore` are dropped after decay and weights.
- **MMR.** Optional greedy Jaccard-token diversity re-ranking before truncation.
- **Caching.** File content is cached by `mtime` + size; the chunk index is
  rebuilt when the selected file signature changes. There is no background
  watcher; an external edit becomes visible on the next search or injection.

Search is full-text only; embeddings and vector search are not implemented.

---

## Security and privacy

- Memory is stored outside repositories under `$DSH_HOME/memory` by default.
- Files are private (`0600`) and directories `0700`.
- `memory_get` rejects paths outside the memory root, including symlink escapes.
- `memory_forget` and `/memory clear` verify every target is inside the root.
- The prompt tells the model not to store secrets, credentials, tokens,
  transient task state, speculative conclusions, or quickly stale facts.
- Memory may contain untrusted text from previous sessions. The prompt and tool
  descriptions treat it as historical context to verify, not as instructions
  that override the user.
- The plugin makes no network requests and spawns no processes.

Use `/memory clear ... --yes` (or delete the directory) to remove stored data.
Setting `enabled: false` keeps files on disk but registers no tools, commands,
prompt section, or injection.

---

## Differences from Grok Build's implementation

| Area | Grok Build | dsh-memory |
|---|---|---|
| Embeddings / vector search | Optional model-backed hybrid search | Full-text BM25 only (Grok's default when unset) |
| Index storage | SQLite FTS5 + vector tables | In-memory chunk index over Markdown |
| File watcher | Native watcher reindexes external edits | mtime/size cache invalidated on next search |
| Automatic Dream | Gated background LLM consolidation | `/dream` delegates consolidation to the active agent |
| `/flush` | LLM-generated session summary | Deterministic transcript capture |
| Memory browser | `/memory` TUI modal with preview | `/memory` command output and `memory_list` tool |
| Automatic session save | Metadata summary at session end | Per-turn bounded transcript sections |
| Tools | `memory_search`, `memory_get` | Adds `memory_list`, `memory_remember`, `memory_forget` |
| Legacy carry-over | Migrates old `MEMORY.md` sessions | Not applicable |

The core product behavior — two scopes, Markdown topics and observations,
generated indexes, first-turn injection, session logs, decay, MMR, and
verification guidance — is preserved.

---

## Development

```bash
cd dsh-memory
npm run check   # syntax-check JS, parse JSON, verify bundle entry points
npm test        # node --test; 53 unit and integration tests
```

The test suite covers tokenization (Latin + Chinese), Markdown chunking,
workspace identity, configuration validation, storage and path safety, BM25,
decay, source weights, MMR, session capture and deduplication, tool execution,
command parsing and handlers, injection, and refresh.

The package has no dependencies; tests use only Node's built-in test runner.

### Layout

```text
dsh-memory/
├── index.js              plugin entry: name / inject / apply
├── lib/
│   ├── config.js         option validation and defaults
│   ├── paths.js          DSH home, workspace identity, slugs, containment
│   ├── text.js           tokenizer, truncation, snippets, stop words
│   ├── markdown.js       frontmatter, titles, notes, chunking
│   ├── fsutil.js         atomic writes, bounded reads, private permissions
│   ├── search.js         BM25, decay, source weights, MMR
│   ├── store.js          scopes, topics, observations, index, manifest
│   ├── capture.js        turn capture, session logs, deduplication
│   ├── tools.js          five model-facing tools
│   ├── commands.js       five slash commands
│   └── runtime.js        store cache, injection, prompt, capture wiring
├── locale/en.json        plugin metadata
├── locale/zh.json
├── icon.svg
├── cordis.patch.yml      bundle patch
└── test/                 unit and integration tests
```

### Verification performed

- `node --test`: 53/53 passing.
- Isolated DSH headless boot with the package loaded by absolute path: plugin
  activates with no "did not activate" warning.
- Isolated bundle install (`dsh plugin --profile <name> add <dir>`): the bundle
  layer is selected automatically and the plugin loads by package name.
- GitHub install (`dsh plugin --profile <name> add github:douglarek/dsh-memory`):
  pnpm records the Git dependency, the bundle layer is selected automatically,
  and the installed plugin runs its memory tools in a live session.
- Live model turns call `memory_remember` and `memory_search` successfully, write
  topics and the generated index, and capture the session log.
- A second, fresh session recalls the first session's topic from the injected
  index without any tool call.
- The session log contains the injected `<memory-context>` message with source
  `kind: "dsh-memory"`, and the system prompt contains the `<memory>` section.

---

## License

MIT.
