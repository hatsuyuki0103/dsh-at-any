#!/usr/bin/env node
/**
 * Repair Session artifacts damaged by dsh-at-any 0.1.2 and earlier.
 *
 * Those versions injected `@path` references with a `source` the Harness
 * refuses when it migrates a Session log:
 *
 *   { "kind": "at-file-mention", "relative": "鈥? }   (unregistered source kind)
 *   { "kind": "plugin", "relative": "鈥? }            (foreign member, no plugin name)
 *
 * The Session format migration is all-or-nothing, so one such message makes the
 * entire artifact unreadable: loading history fails with
 * "cannot safely transform unclassified message source".
 *
 * This tool normalizes exactly those sources to the admitted canonical form
 *
 *   { "kind": "plugin", "plugin": "dsh-at-any" }
 *
 * and nothing else. The referenced path is not affected: it lives in the
 * message content as `<workspace-reference path="鈥? kind="鈥? />`.
 *
 * Safety contract for --apply, per artifact:
 *   1. the original is copied to a backup and the copy's digest is verified;
 *   2. the rebuilt artifact is written to a sibling temporary file;
 *   3. the real Harness migration is run over the temporary file, and a refusal
 *      aborts the artifact with the original left untouched;
 *   4. only then is the temporary file moved into place;
 *   5. the published artifact is migrated once more to confirm.
 *
 * Physical layout: a `.jsonl.zstd` artifact is a sequence of independently
 * decodable, checksummed Zstandard frames 鈥?a header frame followed by record
 * frames. Frames are rebuilt one by one so the container stays valid.
 *
 * Usage:
 *   node repair-session-sources.mjs --check   <sessionsRoot>
 *   node repair-session-sources.mjs --dry-run <sessionsRoot>
 *   node repair-session-sources.mjs --apply   <sessionsRoot>
 *
 * Options:
 *   --backup-root <dir>   where --apply writes backups (default: <sessionsRoot>/../dsh-at-any-backups)
 *   --harness <dir>       @deepseek-ai package directory used for migration validation
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ZSTD_MAGIC = 4247762216
const REPAIRED_SOURCE = { kind: 'plugin', plugin: 'dsh-at-any' }

/**
 * Artifact names the JSONL backend writes, one per format generation:
 * `session.jsonl` (v0) and `session.v<N>.jsonl` (vN), each optionally
 * `.zstd`-compressed. The backend resolves a Session by taking the HIGHEST
 * generation present in its directory, so a stale lower generation can sit
 * beside the artifact that actually loads.
 */
const ARTIFACT_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u

/** Source shapes this tool repairs. */
function isRefusedSource(source) {
  if (source === null || typeof source !== 'object') return false
  if (source.kind === 'at-file-mention') return true
  return source.kind === 'plugin' && Object.hasOwn(source, 'relative')
}

/**
 * Locate complete Zstandard frames without decompressing their blocks, mirroring
 * the JSONL persistence backend's scanner.
 * @param buffer - complete artifact bytes.
 * @returns complete frame ranges.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Encode one independently decodable, checksummed frame, as the backend does. */
function encodeFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** Decode an artifact into its frame texts. */
function readArtifact(filePath) {
  const bytes = readFileSync(filePath)
  // Dispatch on content, not on the file name: temporary artifacts carry a
  // suffix, and the earlier bug here read a compressed file as plain JSONL.
  const compressed = bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC
  if (!compressed) return { compressed: false, bytes, texts: [bytes.toString('utf8')] }
  const frames = scanFrames(bytes)
  if (frames.length === 0) throw new Error('no complete Zstandard frames')
  return { compressed: true, bytes, texts: frames.map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')) }
}

/** Count the offending sources in one artifact without modifying it. */
function inspect(texts) {
  const counts = new Map()
  for (const [index, text] of texts.entries()) {
    if (index === 0 && text.startsWith('{"type":"session"')) continue
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.type !== 'user/message') continue
      const source = row.data?.source
      if (!isRefusedSource(source)) continue
      const shape = source.kind === 'at-file-mention' ? 'at-file-mention' : 'plugin+relative'
      counts.set(shape, (counts.get(shape) ?? 0) + 1)
    }
  }
  return counts
}

/** Rebuild an artifact with normalized sources; returns repair statistics. */
function rebuild(texts, compressed, targetPath) {
  const counts = new Map()
  if (!compressed) {
    const rebuilt = texts[0].split('\n').map((line) => {
      if (line.trim() === '') return line
      let row
      try { row = JSON.parse(line) } catch { return line }
      if (row.type !== 'user/message' || !isRefusedSource(row.data?.source)) return line
      const shape = row.data.source.kind === 'at-file-mention' ? 'at-file-mention' : 'plugin+relative'
      counts.set(shape, (counts.get(shape) ?? 0) + 1)
      row.data.source = { ...REPAIRED_SOURCE }
      return JSON.stringify(row)
    })
    writeFileSync(targetPath, rebuilt.join('\n'))
    return counts
  }
  const outFrames = []
  for (const [index, text] of texts.entries()) {
    if (index === 0) { outFrames.push(encodeFrame(text)); continue }
    const lines = text.split('\n')
    const trailing = lines[lines.length - 1] === ''
    const records = trailing ? lines.slice(0, -1) : lines
    const rebuilt = records.map((line) => {
      if (line.trim() === '') return line
      let row
      try { row = JSON.parse(line) } catch { return line }
      if (row.type !== 'user/message' || !isRefusedSource(row.data?.source)) return line
      const shape = row.data.source.kind === 'at-file-mention' ? 'at-file-mention' : 'plugin+relative'
      counts.set(shape, (counts.get(shape) ?? 0) + 1)
      row.data.source = { ...REPAIRED_SOURCE }
      return JSON.stringify(row)
    })
    outFrames.push(encodeFrame(`${rebuilt.join('\n')}${trailing ? '\n' : ''}`))
  }
  writeFileSync(targetPath, Buffer.concat(outFrames))
  return counts
}

/** Load the Harness migration catalog lazily; validation is optional but recommended. */
async function loadCatalog(harnessDir) {
  const entry = `${harnessDir}/dsh-session-format-catalog/lib/index.js`
  if (!existsSync(entry)) return undefined
  const module = await import(pathToFileURL(entry).href)
  return module.sessionFormatCatalog
}

/** Run the real migration over an artifact; never throws. */
function migrate(catalog, filePath) {
  if (catalog === undefined) return { skipped: true }
  try {
    const { texts } = readArtifact(filePath)
    const header = JSON.parse(texts[0].split('\n')[0])
    const restore = catalog.createRestore(header, { recovery: 'recoverable', validation: 'transformed' })
    for (let index = 1; index < texts.length; index += 1) {
      for (const line of texts[index].split('\n')) {
        if (line.trim() === '') continue
        restore.decodeRow(JSON.parse(line))
      }
    }
    const artifact = restore.finish()
    return { ok: true, events: artifact.events.length }
  } catch (error) {
    return { ok: false, error: `${error?.name}: ${error?.message}` }
  }
}

function digestOf(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/**
 * Enumerate candidate artifacts under a store root, grouped by the directory
 * that owns them (one Session per directory). The live layout is
 * `<root>/<project>/<session>/session[.vN].jsonl[.zstd]`; a backup root keeps
 * the same shape, so the walk descends one level further to cover both.
 *
 * Every generation is returned, not just the legacy name: a Session directory
 * can hold a stale v0 artifact beside the v3 artifact the backend actually
 * loads, and reporting only the former would hide real damage.
 *
 * @param root - store or backup root.
 * @returns one `{ dir, artifacts }` entry per Session directory that holds any.
 */
function findSessionDirs(root) {
  const dirs = new Map()
  const walk = (dir, depth) => {
    if (depth > 5) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    const here = []
    for (const entry of entries) {
      const full = join(dir, entry)
      let info
      try { info = statSync(full) } catch { continue }
      if (info.isDirectory()) { walk(full, depth + 1); continue }
      const match = ARTIFACT_NAME.exec(entry)
      if (match === null) continue
      here.push({ path: full, name: entry, version: match[1] === undefined ? 0 : Number(match[1]), compressed: match[2] !== undefined })
    }
    if (here.length > 0) {
      // Highest generation wins, matching the backend's resolution.
      here.sort((left, right) => right.version - left.version)
      dirs.set(dir, here)
    }
  }
  walk(root, 0)
  return dirs
}

/** Flat list of every artifact under a root, for temporary-file sweeps. */
function findAllArtifacts(root) {
  const found = []
  for (const artifacts of findSessionDirs(root).values()) for (const artifact of artifacts) found.push(artifact.path)
  return found
}

function parseArgs(argv) {
  const rawMode = argv.find(a => a === '--check' || a === '--dry-run' || a === '--apply' || a === '--self-test')
  // Strip the leading dashes: every later comparison uses the bare name. An
  // earlier version compared the dashed form against 'dry-run', so --dry-run
  // fell through into the applying branch and overwrote its own backups.
  const mode = rawMode?.replace(/^--/u, '')
  const rest = argv.filter(a => !a.startsWith('--'))
  const flagValue = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  const root = rest[0]
  if (mode === undefined || (root === undefined && mode !== 'self-test')) {
    console.error('usage: node repair-session-sources.mjs --check|--dry-run|--apply <sessionsRoot>')
    console.error('       node repair-session-sources.mjs --self-test')
    console.error('       [--backup-root <dir>] [--harness <@deepseek-ai package dir>]')
    process.exit(2)
  }
  const resolvedRoot = root === undefined ? undefined : resolve(root)
  return {
    mode,
    root: resolvedRoot,
    backupRoot: resolve(flagValue('--backup-root', resolvedRoot === undefined ? '.' : join(resolvedRoot, '..', 'dsh-at-any-backups'))),
    harnessDir: flagValue('--harness', 'C:/Users/yaoyufeng/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    noValidate: argv.includes('--no-validate'),
  }
}

/**
 * Exercise this CLI's safety contract against a synthetic damaged artifact, in
 * a temporary directory, by spawning the CLI as a child process.
 *
 * This exists because an earlier revision shipped a defect that a test of this
 * shape catches immediately: the mode string kept its `--` prefix, so
 * `--dry-run` fell through into the applying branch, wrote backups, and
 * replaced the artifact it was only asked to preview.
 *
 * @param harnessDir - directory holding the @deepseek-ai packages, if present.
 */
async function selfTest(harnessDir) {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const failures = []
  const check = (label, condition) => {
    console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
    if (!condition) failures.push(label)
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-at-any-repair-selftest-'))
  try {
    // A damaged artifact: the header frame plus frames carrying records. The
    // record sequence is a faithful minimal released-v0 session 鈥?the migration
    // gate refuses a damaged fixture for an unrelated structural reason, so the
    // fixture has to be a real Session, not just "a row with a bad source".
    const header = JSON.stringify({ type: 'session', version: 0, id: 'session-selftest', createdAt: 0, cwd: workRoot, delegationDepth: 0 })
    const rows = [
      { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } },
      { type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', seq: 2, time: 3, data: { policy: 'never' } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } },
      { type: 'step/start', seq: 4, time: 5, data: { turn: 1, step: 1 } },
      {
        type: 'user/message',
        seq: 5,
        time: 6,
        data: {
          content: [{ type: 'text', text: '<workspace-reference path="a.ts" kind="file" />' }],
          source: { kind: 'at-file-mention', relative: 'a.ts' },
          role: 'user',
          id: 'selftest-1',
        },
        surfaceOp: 'append',
      },
      { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const store = join(workRoot, 'sessions', '--proj--', 'session-selftest')
    mkdirSync(store, { recursive: true })
    const artifact = join(store, 'session.jsonl.zstd')
    const body = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    writeFileSync(artifact, Buffer.concat([encodeFrame(`${header}\n`), encodeFrame(body)]))
    const damagedDigest = digestOf(artifact)
    const backups = join(workRoot, 'backups')

    const run = (mode, storeRoot = join(workRoot, 'sessions')) => {
      const result = spawnSync(process.execPath, [
        process.argv[1], `--${mode}`, storeRoot, '--backup-root', backups, '--harness', harnessDir,
      ], { encoding: 'utf8' })
      if (process.env.DSH_AT_ANY_REPAIR_SELFTEST_VERBOSE === '1') {
        console.log(`--- child --${mode} (status ${result.status}) ---`)
        console.log(`stdout:\n${result.stdout}`)
        if (result.stderr !== '') console.log(`stderr:\n${result.stderr}`)
      }
      return result
    }

    const checkRun = run('check')
    check('--check reports the damaged artifact', checkRun.stdout.includes('offending user/message'))
    check('--check leaves the artifact byte-identical', digestOf(artifact) === damagedDigest)

    const dryRun = run('dry-run')
    check('--dry-run reports a preview', dryRun.stdout.includes('dry run: original left untouched'))
    check('--dry-run leaves the artifact byte-identical', digestOf(artifact) === damagedDigest)
    check('--dry-run writes no backup', !existsSync(backups))

    const apply = run('apply')
    check('--apply publishes a repaired artifact', digestOf(artifact) !== damagedDigest)
    check('--apply wrote a backup', existsSync(join(backups, '--proj--', 'session-selftest', 'session.jsonl.zstd')))
    const backupPath = join(backups, '--proj--', 'session-selftest', 'session.jsonl.zstd')
    check('--apply backup is the pre-repair artifact, byte-identical', existsSync(backupPath) && digestOf(backupPath) === damagedDigest)
    check('--apply leaves no temporary file behind', findAllArtifacts(join(workRoot, 'sessions')).every(p => !p.endsWith('.repair-tmp')))

    // The repaired artifact must be a faithful repair: same event coordinates,
    // only the source normalized.
    const repairedRows = readArtifact(artifact).texts
      .flatMap(text => text.split('\n'))
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line))
    const repairedRow = repairedRows.find(row => row.type === 'user/message')
    check('repaired source is the canonical plugin source', repairedRow !== undefined
      && JSON.stringify(repairedRow.data.source) === JSON.stringify(REPAIRED_SOURCE))
    check('repaired row keeps its identity and content', repairedRow !== undefined && repairedRow.seq === 5
      && repairedRow.data.id === 'selftest-1'
      && repairedRow.data.content[0].text === '<workspace-reference path="a.ts" kind="file" />')
    check('every original record survives the repair', repairedRows.length === rows.length + 1)

    // Generation coverage: the backend writes `session.v<N>.jsonl.zstd` once a
    // Session has been migrated, and loads the HIGHEST generation present. An
    // earlier revision matched only the legacy names, so a damaged v3 artifact
    // was reported as "no damaged artifacts found".
    const generationDir = join(workRoot, 'generations', '--proj--', 'session-gen')
    mkdirSync(generationDir, { recursive: true })
    const v0 = join(generationDir, 'session.jsonl.zstd')
    const v3 = join(generationDir, 'session.v3.jsonl.zstd')
    copyFileSync(artifact, v3)
    writeFileSync(v0, readFileSync(artifact))
    const generationRun = run('check', join(workRoot, 'generations'))
    check('a versioned artifact name is discovered', generationRun.stdout.includes('session.v3.jsonl.zstd'))
    check('the loaded generation is identified', generationRun.stdout.includes('backend loads: session.v3.jsonl.zstd'))

    // Ungated apply must fail closed rather than overwrite without validation.
    const ungated = spawnSync(process.execPath, [
      process.argv[1], '--apply', join(workRoot, 'generations'), '--backup-root', join(workRoot, 'backups2'),
      '--harness', join(workRoot, 'does-not-exist'),
    ], { encoding: 'utf8' })
    check('--apply without a migration catalog refuses (exit 2)', ungated.status === 2)

    console.log(failures.length === 0
      ? '\nself-test: PASS'
      : `\nself-test: FAIL (${failures.length})\n  - ${failures.join('\n  - ')}`)
    if (failures.length > 0) process.exit(1)
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

const options = parseArgs(process.argv.slice(2))

if (options.mode === 'self-test') {
  await selfTest(options.harnessDir)
  process.exit(0)
}

const catalog = await loadCatalog(options.harnessDir)

// Fail closed: without the real migration catalog there is no gate left, and an
// ungated --apply would overwrite artifacts on the strength of a rebuild that
// nothing validated. Refuse instead of degrading the guarantee silently.
if (catalog === undefined && (options.mode === 'apply' || options.mode === 'dry-run')) {
  console.error(`error: no Harness migration catalog at ${options.harnessDir}`)
  console.error('       repair is gated on the real migration; pass --harness <dir>, or --no-validate to override')
  if (!options.noValidate) process.exit(2)
}

const sessionDirs = findSessionDirs(options.root)
const artifactCount = [...sessionDirs.values()].reduce((sum, list) => sum + list.length, 0)
console.log(`mode=${options.mode}  root=${options.root}  sessions=${sessionDirs.size}  artifacts=${artifactCount}`)

let damaged = 0
let repaired = 0
let previewed = 0
let failed = 0

for (const [sessionDir, artifacts] of sessionDirs) {
  // The backend loads the highest generation in the directory; report it so a
  // stale lower generation can never be mistaken for the artifact in use.
  const resolved = artifacts[0]
  if (artifacts.length > 1) {
    console.log(`\n  SESSION ${sessionDir}`)
    console.log(`    generations present: ${artifacts.map(a => `${a.name}(v${a.version})`).join(', ')}`)
    console.log(`    backend loads: ${resolved.name}`)
  }

  for (const artifact of artifacts) {
    const artifactPath = artifact.path
    const inUse = artifact === resolved && artifacts.length > 1
    let texts
    let compressed
    try {
      ;({ texts, compressed } = readArtifact(artifactPath))
    } catch (error) {
      console.log(`  UNREADABLE ${artifactPath}: ${error.message}`)
      continue
    }
    const counts = inspect(texts)
    if (counts.size === 0) continue
    damaged += 1
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
    console.log(`\n  DAMAGED ${artifactPath}${inUse ? '  [the artifact the backend loads]' : ''}`)
    console.log(`    offending user/message: ${total} ${JSON.stringify(Object.fromEntries(counts))}`)
    const before = migrate(catalog, artifactPath)
    console.log(`    migration before: ${before.skipped ? 'skipped' : before.ok ? `ok (${before.events} events)` : `REFUSED (${before.error})`}`)

    if (options.mode === 'check') continue

    const tempPath = `${artifactPath}.repair-tmp`
    try {
      const applied = rebuild(texts, compressed, tempPath)
      const after = migrate(catalog, tempPath)
      if (after.skipped) throw new Error('no migration catalog: refusing to publish an unvalidated artifact')
      if (after.ok === false) throw new Error(`rebuilt artifact is still refused: ${after.error}`)
      console.log(`    rebuilt: repaired=${[...applied.values()].reduce((s, n) => s + n, 0)}, migration ok (${after.events} events)`)

      if (options.mode === 'dry-run') {
        rmSync(tempPath, { force: true })
        previewed += 1
        console.log('    dry run: original left untouched')
        continue
      }

      const relative = artifactPath.slice(options.root.length).replace(/^[/\\]+/u, '')
      const backupPath = join(options.backupRoot, relative)
      mkdirSync(dirname(backupPath), { recursive: true })
      if (existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`)
      const originalDigest = digestOf(artifactPath)
      copyFileSync(artifactPath, backupPath)
      if (digestOf(backupPath) !== originalDigest) throw new Error('backup digest mismatch; aborting')
      renameSync(tempPath, artifactPath)
      const published = migrate(catalog, artifactPath)
      if (published.ok === false) throw new Error(`published artifact failed re-validation: ${published.error}`)
      repaired += 1
      console.log(`    REPAIRED (backup: ${backupPath})`)
    } catch (error) {
      rmSync(tempPath, { force: true })
      failed += 1
      console.log(`    FAILED: ${error.message}`)
    }
  }
}

console.log(`\ndamaged=${damaged} repaired=${repaired} previewed=${previewed} failed=${failed}`)
if (options.mode === 'check') {
  console.log(damaged === 0 ? 'no damaged artifacts found' : 'run with --dry-run to preview repairs, then --apply')
}
process.exit(failed > 0 ? 1 : 0)
