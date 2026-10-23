import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isWithin,
  normalizeRemoteUrl,
  resolveDshHome,
  resolveWorkspaceScope,
  slugify,
} from '../lib/paths.js'

test('normalizeRemoteUrl handles common git forms', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:org/repo.git'), 'org/repo')
  assert.equal(normalizeRemoteUrl('ssh://git@github.com/org/repo.git'), 'org/repo')
  assert.equal(normalizeRemoteUrl('https://github.com/org/repo.git'), 'org/repo')
  assert.equal(normalizeRemoteUrl('https://gitlab.com/group/sub/repo'), 'group/sub/repo')
  assert.equal(normalizeRemoteUrl('not a url'), null)
  assert.equal(normalizeRemoteUrl('https://github.com/only-one-segment'), null)
})

test('slugify keeps Unicode letters and collapses separators', () => {
  assert.equal(slugify('Auth Middleware'), 'auth-middleware')
  assert.equal(slugify('构建 与 测试'), '构建-与-测试')
  assert.equal(slugify('  --Hello__World--  '), 'hello-world')
  assert.equal(slugify('!!!'), '')
})

test('isWithin rejects sibling and parent paths', () => {
  assert.equal(isWithin('/tmp/memory', '/tmp/memory/global/MEMORY.md'), true)
  assert.equal(isWithin('/tmp/memory', '/tmp/memory-other/x'), false)
  assert.equal(isWithin('/tmp/memory', '/tmp'), false)
})

test('resolveDshHome honors DSH_HOME and falls back', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-dsh' }), '/tmp/custom-dsh')
  assert.ok(resolveDshHome({}).endsWith('.dsh'))
})

test('clones of the same remote share a workspace directory name', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-memory-paths-'))
  try {
    const first = join(base, 'first')
    const second = join(base, 'second')
    for (const root of [first, second]) {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(
        join(root, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:example/project.git\n',
      )
    }
    const left = await resolveWorkspaceScope(first)
    const right = await resolveWorkspaceScope(second)
    assert.equal(left.dirName, right.dirName)
    assert.ok(left.dirName.startsWith('project-'))
    assert.equal(left.identity, 'example/project')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
