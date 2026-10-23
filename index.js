/**
 * dsh-memory — cross-session persistent memory for DeepSeek Harness.
 *
 * The plugin has no dependencies outside Node built-ins.
 *
 * @module dsh-memory
 */

import { resolveConfig } from './lib/config.js'
import { MemoryRuntime } from './lib/runtime.js'
import { registerTools } from './lib/tools.js'
import { registerCommands } from './lib/commands.js'

export const name = 'dsh-memory'
export const inject = ['tools']

/**
 * Mount the memory runtime.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {unknown} rawConfig The bundle row's `config`.
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    ctx.logger?.error?.('dsh-memory: invalid configuration:', error)
    throw error
  }

  for (const warning of config.warnings) ctx.logger?.warn?.(`dsh-memory: ${warning}`)

  if (!config.enabled) {
    ctx.logger?.info?.('dsh-memory: disabled by configuration')
    return
  }

  const runtime = new MemoryRuntime({ ctx, config })
  ctx.effect(() => () => runtime.dispose(), 'dsh-memory.dispose')
  runtime.install(ctx)

  registerTools(ctx, runtime)
  registerCommands(ctx, runtime)

  ctx.logger?.info?.(`dsh-memory: enabled (root=${config.memoryRootDisplay})`)
}
