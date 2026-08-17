/**
 * dsh-at-any guarantees: no practical index truncation and all-source-format
 * inclusion. These lock the fix for the original dsh-at-file bug (default
 * maxIndexedFiles=5000 dropped .java/.vue files in the user's 11k-file
 * workspace) and the "all formats" requirement (no extension filtering,
 * hidden files and extension-less files included; build-artifact dirs still
 * skipped by default).
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexWorkspace } from '../src/files.ts'
import { DEFAULT_IGNORE_DIRS, DEFAULT_MAX_INDEXED_FILES } from '../src/defaults.ts'

/** A workspace with many source formats + artifact dirs, ~40 source files. */
async function allFormatsFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-at-any-allformats-'))
  const mk = async (rel: string): Promise<void> => { await mkdir(join(root, rel), { recursive: true }) }
  await mk('src/main/java/com/example/service')
  await mk('src/main/resources')
  await mk('src/main/vue/views')
  await mk('src/main/assets/img')
  await mk('docs')
  await mk('target/classes')
  await mk('dist/assets')
  await mk('build/libs')
  await mk('node_modules/pkg')
  // Source formats (the formats users complained were missing).
  for (let i = 0; i < 10; i++) {
    await writeFile(join(root, 'src/main/java/com/example/service', `OrderService${i}.java`), 'class X {}\n')
  }
  await writeFile(join(root, 'src/main/vue/views', 'shipOrder.vue'), '<template/>\n')
  await writeFile(join(root, 'src/main/vue/views', 'index.vue'), '<template/>\n')
  await writeFile(join(root, 'src/main/resources', 'application.yml'), 'key: value\n')
  await writeFile(join(root, 'src/main/resources', 'schema.sql'), 'select 1;\n')
  await writeFile(join(root, 'src/main/assets/img', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(root, 'docs', 'spec.pdf'), '%PDF-1.4 fake\n')
  await writeFile(join(root, 'src/main/vue', 'Makefile'), 'all:\n') // extension-less
  await writeFile(join(root, '.env'), 'SECRET=x\n') // hidden file
  await writeFile(join(root, 'src/main/java', 'README'), 'no extension\n') // extension-less
  // Artifact dirs that must stay skipped.
  await writeFile(join(root, 'target/classes', 'Built.class'), 'x')
  await writeFile(join(root, 'dist/assets', 'bundle.js'), 'x')
  await writeFile(join(root, 'build/libs', 'app.jar'), 'x')
  await writeFile(join(root, 'node_modules/pkg', 'dep.js'), 'x')
  return root
}

describe('dsh-at-any: no truncation + all formats', () => {
  it('indexes every source file with the default (effectively unlimited) cap', async () => {
    const root = await allFormatsFixture()
    try {
      const { files, truncated } = await indexWorkspace(root, {
        maxFiles: 1_000_000,
        ignoreDirs: [...DEFAULT_IGNORE_DIRS],
        ignoreFiles: [],
      })
      expect(truncated).toBe(false)
      const relatives = files.map(file => file.relative)
      // All ten .java files present (the original bug dropped these).
      for (let i = 0; i < 10; i++) {
        expect(relatives).toContain(`src/main/java/com/example/service/OrderService${i}.java`)
      }
      // All formats visible: .vue, .yml, .sql, .png, .pdf, extension-less, hidden.
      expect(relatives).toContain('src/main/vue/views/shipOrder.vue')
      expect(relatives).toContain('src/main/vue/views/index.vue')
      expect(relatives).toContain('src/main/resources/application.yml')
      expect(relatives).toContain('src/main/resources/schema.sql')
      expect(relatives).toContain('src/main/assets/img/logo.png')
      expect(relatives).toContain('docs/spec.pdf')
      expect(relatives).toContain('src/main/vue/Makefile')
      expect(relatives).toContain('src/main/java/README')
      expect(relatives).toContain('.env')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still skips artifact directories by default', async () => {
    const root = await allFormatsFixture()
    try {
      const { files } = await indexWorkspace(root, {
        maxFiles: 1_000_000,
        ignoreDirs: [...DEFAULT_IGNORE_DIRS],
        ignoreFiles: [],
      })
      const relatives = files.map(file => file.relative)
      expect(relatives.some(path => path.includes('target'))).toBe(false)
      expect(relatives.some(path => path.includes('dist'))).toBe(false)
      expect(relatives.some(path => path.includes('build'))).toBe(false)
      expect(relatives.some(path => path.includes('node_modules'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('DEFAULT_IGNORE_DIRS keeps the artifact dirs (regression guard)', () => {
    for (const dir of ['target', 'dist', 'build', 'bin', 'out', 'obj', 'node_modules', '.git']) {
      expect(DEFAULT_IGNORE_DIRS).toContain(dir)
    }
  })

  it('ignoreFiles rules still apply on top of all-format indexing', async () => {
    const root = await allFormatsFixture()
    try {
      const { files } = await indexWorkspace(root, {
        maxFiles: 1_000_000,
        ignoreDirs: [...DEFAULT_IGNORE_DIRS],
        ignoreFiles: [{ kind: 'exact', pattern: 'application.yml', caseSensitive: false }],
      })
      const relatives = files.map(file => file.relative)
      expect(relatives).not.toContain('src/main/resources/application.yml')
      // Everything else stays indexed despite the filter.
      expect(relatives).toContain('src/main/resources/schema.sql')
      expect(relatives).toContain('src/main/java/com/example/service/OrderService0.java')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('DEFAULT_MAX_INDEXED_FILES is effectively unlimited (>= 1M)', () => {
    expect(DEFAULT_MAX_INDEXED_FILES).toBeGreaterThanOrEqual(1_000_000)
  })
})
