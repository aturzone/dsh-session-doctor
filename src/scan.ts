/**
 * Read-only signature scanner for durable Harness session logs.
 *
 * It decodes each canonical JSONL generation (optionally zstd-compressed) and replays the
 * turn/step/event-scope rules that the current reader (`session-format-v3-to-v4`) enforces.
 * Its purpose is diagnosis: it names the event signature that would make a stored session
 * unloadable, without importing internal packages or mutating files.
 * @module dsh-session-doctor/scan
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** One diagnosed defect in a stored session. */
export interface SessionIssue {
  /** Reader rule family the event violates. */
  readonly code:
    | 'missing-header'
    | 'invalid-row'
    | 'turn-sequence'
    | 'turn-start-nested'
    | 'turn-end-without-turn'
    | 'turn-end-with-open-step'
    | 'step-outside-turn'
    | 'step-start-nested'
    | 'step-numbering'
    | 'step-end-mismatch'
    | 'turn-scope'
  /** Sequence number of the offending event, when the row parsed. */
  readonly seq?: number
  /** Event type of the offending row, when known. */
  readonly type?: string
  /** Human-readable explanation with the expected state. */
  readonly detail: string
}

/** Result of scanning one session directory's active generation. */
export interface SessionReport {
  /** Session directory basename. */
  readonly sessionDir: string
  /** Workspace bucket directory basename (the encoded project path). */
  readonly workspace: string
  /** Canonical generation file that was scanned. */
  readonly file: string
  /** Logical format version parsed from the header or filename. */
  readonly version?: number
  /** Whether the generation is zstd-compressed. */
  readonly compressed: boolean
  /** Header identity, when the header row parsed. */
  readonly sessionId?: string
  /** Header working directory, when present. */
  readonly cwd?: string
  /** Number of event rows (excluding the header). */
  readonly eventCount: number
  /** Whether the file could be decoded at all. */
  readonly readable: boolean
  /** Defects found while replaying the reader rules. */
  readonly issues: readonly SessionIssue[]
}

/** Aggregate scan result. */
export interface ScanResult {
  /** Directory whose session buckets were scanned. */
  readonly sessionsRoot: string
  /** One report per session directory, sorted by path. */
  readonly sessions: readonly SessionReport[]
}

/** Options for {@link scanSessions}. */
export interface ScanOptions {
  /** Harness home (defaults to `$DSH_HOME` or `~/.dsh`). */
  readonly home?: string
  /** Session root override; defaults to `<home>/sessions`. */
  readonly sessionsRoot?: string
  /** Audit every retained generation instead of only the highest one per session. */
  readonly allGenerations?: boolean
}

const SESSION_FILE = /^session\.v(\d+)\.jsonl(\.zstd)?$/
/** Event types the V4 reader accepts only while a turn is open. */
const TURN_SCOPED = new Set(['request/header', 'request/context', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'llm/retry'])
/** Event types the V4 reader accepts only while both a turn and a step are open. */
const STEP_SCOPED = new Set(['system/message', 'developer/message', 'assistant/attempt', 'assistant/message', 'tool/call'])

interface HeaderRow {
  readonly type: 'session'
  readonly version: number
  readonly id?: string
  readonly cwd?: string
}

interface EventRow {
  readonly type: string
  readonly seq: number
  readonly turn?: number
  readonly step?: number
  readonly surfaceOp?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Decode one stored generation into its header row and event rows.
 * @param file - Absolute path to a `session.vN.jsonl[.zstd]` file.
 * @returns Parsed rows plus decode diagnostics.
 */
export function decodeSessionFile(file: string, bytes: Uint8Array): {
  readonly header?: HeaderRow
  readonly events: readonly EventRow[]
  readonly issues: readonly SessionIssue[]
} {
  const text = sessionText(file, bytes)
  if (text === undefined) return { events: [], issues: [{ code: 'invalid-row', detail: 'compressed generation is not decodable' }] }
  const issues: SessionIssue[] = []
  let header: HeaderRow | undefined
  const events: EventRow[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      issues.push({ code: 'invalid-row', detail: 'row is not valid JSON' })
      continue
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      issues.push({ code: 'invalid-row', detail: 'row is not a session event object' })
      continue
    }
    if (header === undefined) {
      if (parsed['type'] === 'session' && typeof parsed['version'] === 'number') {
        header = parsed as unknown as HeaderRow
        continue
      }
      issues.push({ code: 'missing-header', detail: 'first row is not a session header' })
    }
    if (typeof parsed['seq'] !== 'number') {
      issues.push({ code: 'invalid-row', type: parsed['type'], detail: 'event row has no numeric seq' })
      continue
    }
    events.push(parsed as unknown as EventRow)
  }
  if (header === undefined) issues.push({ code: 'missing-header', detail: 'generation has no session header row' })
  return { header, events, issues }
}

function sessionText(file: string, bytes: Uint8Array): string | undefined {
  if (!file.endsWith('.zstd')) return new TextDecoder().decode(bytes)
  try {
    // Node exposes zstd decompression since v22.15; the runtime floor here is 24.9.
    return new TextDecoder().decode(zstdDecompressSync(bytes))
  } catch {
    return undefined
  }
}

/**
 * Replay the V4 reader's turn/step/scope rules over decoded events and report
 * the first fatal signature per rule family.
 * @param events - Event rows in stored order.
 * @returns Issues in row order.
 */
export function analyzeEvents(events: readonly EventRow[]): SessionIssue[] {
  const issues: SessionIssue[] = []
  let turn: number | null = null
  let step: number | null = null
  let nextTurn = 1
  let nextStep = 1
  for (const event of events) {
    const seq = event.seq
    const type = event.type
    switch (type) {
      case 'turn/start': {
        if (turn !== null) issues.push({ code: 'turn-start-nested', seq, type, detail: 'turn/start while a turn is open' })
        turn = nextTurn
        step = null
        nextStep = 1
        break
      }
      case 'turn/end': {
        if (turn === null) issues.push({ code: 'turn-end-without-turn', seq, type, detail: 'turn/end without an open turn' })
        else if (step !== null) issues.push({ code: 'turn-end-with-open-step', seq, type, detail: 'turn/end while a step is open' })
        else {
          turn = null
          nextTurn += 1
          nextStep = 1
        }
        break
      }
      case 'step/start': {
        if (turn === null) issues.push({ code: 'step-outside-turn', seq, type, detail: 'step/start outside an open turn' })
        else if (step !== null) issues.push({ code: 'step-start-nested', seq, type, detail: 'step/start while a step is open' })
        else {
          const declared = event.turn
          const declaredStep = event.step
          if (typeof declared === 'number' && declared !== turn) {
            issues.push({ code: 'turn-sequence', seq, type, detail: `step/start declares turn ${declared} while turn ${turn} is open` })
          }
          if (typeof declaredStep === 'number' && declaredStep !== nextStep) {
            issues.push({
              code: 'step-numbering', seq, type,
              detail: `step/start declares step ${declaredStep} but the reader expects step ${nextStep} (the numbering restarted inside turn ${turn})`,
            })
          }
          step = typeof declaredStep === 'number' ? declaredStep : nextStep
        }
        break
      }
      case 'step/end': {
        if (turn === null || step === null) issues.push({ code: 'step-end-mismatch', seq, type, detail: 'step/end without an open turn and step' })
        else {
          step = null
          nextStep += 1
        }
        break
      }
      default: {
        if (TURN_SCOPED.has(type) && turn === null) {
          issues.push({ code: 'turn-scope', seq, type, detail: `${type} outside an open turn` })
        } else if ((STEP_SCOPED.has(type) || (type === 'tool/result' && event.surfaceOp === 'append')) && (turn === null || step === null)) {
          issues.push({ code: 'turn-scope', seq, type, detail: `${type} without an open turn and step` })
        } else if (type === 'tool/result' && event.surfaceOp !== 'append' && turn === null) {
          issues.push({ code: 'turn-scope', seq, type, detail: 'replacement tool/result outside an open turn' })
        }
        break
      }
    }
  }
  return issues
}

/** Derive the default Harness home from the environment. */
export function defaultHome(): string {
  const configured = process.env['DSH_HOME']
  if (configured !== undefined && configured.length > 0) return configured
  return join(process.env['HOME'] ?? '.', '.dsh')
}

/**
 * Scan every workspace bucket below `<home>/sessions` and analyze each session's
 * highest canonical generation.
 * @param options - Home or explicit session-root override.
 * @returns All session reports sorted by path.
 */
export async function scanSessions(options: ScanOptions = {}): Promise<ScanResult> {
  const sessionsRoot = options.sessionsRoot ?? join(options.home ?? defaultHome(), 'sessions')
  const sessions: SessionReport[] = []
  const children = await directories(sessionsRoot)
  // Accept either the sessions root (workspace buckets inside) or one workspace
  // bucket (session directories inside): a child holding a session file means
  // the given path is already a workspace bucket.
  if (await containsSessionFile(sessionsRoot, children)) {
    for (const sessionDir of children) {
      sessions.push(...await scanSessionDirectory(sessionsRoot, basename(sessionsRoot), sessionDir, options.allGenerations === true))
    }
    sessions.sort((left, right) => `${left.workspace}/${left.sessionDir}`.localeCompare(`${right.workspace}/${right.sessionDir}`))
    return { sessionsRoot, sessions }
  }
  for (const workspace of children) {
    const workspacePath = join(sessionsRoot, workspace)
    for (const sessionDir of await directories(workspacePath)) {
      sessions.push(...await scanSessionDirectory(workspacePath, workspace, sessionDir, options.allGenerations === true))
    }
  }
  sessions.sort((left, right) => `${left.workspace}/${left.sessionDir}`.localeCompare(`${right.workspace}/${right.sessionDir}`))
  return { sessionsRoot, sessions }
}

async function containsSessionFile(root: string, children: readonly string[]): Promise<boolean> {
  for (const child of children) {
    try {
      const names = await readdir(join(root, child))
      if (names.some(name => SESSION_FILE.test(name))) return true
    } catch {
      // Unreadable child: treat as a workspace bucket and let the session scan report it.
    }
  }
  return false
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

async function scanSessionDirectory(
  workspacePath: string, workspace: string, sessionDir: string, allGenerations: boolean,
): Promise<SessionReport[]> {
  const dir = join(workspacePath, sessionDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const candidates = names
    .map(name => SESSION_FILE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ name: match[0], version: Number(match[1]), compressed: match[2] !== undefined }))
    .sort((left, right) => right.version - left.version)
  const chosen = allGenerations ? candidates : candidates.slice(0, 1)
  if (chosen.length === 0) return []
  return Promise.all(chosen.map(entry => scanGeneration(dir, workspace, sessionDir, entry)))
}

async function scanGeneration(
  dir: string, workspace: string, sessionDir: string,
  chosen: { name: string; version: number; compressed: boolean },
): Promise<SessionReport> {
  const file = join(dir, chosen.name)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(file))
  } catch {
    return { sessionDir, workspace, file, compressed: chosen.compressed, eventCount: 0, readable: false, issues: [{ code: 'invalid-row', detail: 'file is not readable' }] }
  }
  const decoded = decodeSessionFile(file, bytes)
  const issues = [...decoded.issues, ...analyzeEvents(decoded.events)]
  return {
    sessionDir,
    workspace,
    file,
    version: decoded.header?.version ?? chosen.version,
    compressed: chosen.compressed,
    sessionId: decoded.header?.id,
    cwd: decoded.header?.cwd,
    eventCount: decoded.events.length,
    readable: decoded.header !== undefined,
    issues,
  }
}

/** Render a compact human-readable report. */
export function formatReport(result: ScanResult): string {
  const lines: string[] = []
  const suspect = result.sessions.filter(session => session.issues.length > 0)
  lines.push(`session root: ${result.sessionsRoot}`)
  lines.push(`sessions: ${result.sessions.length} scanned, ${suspect.length} with reader-incompatible signatures`)
  for (const session of suspect) {
    lines.push('')
    lines.push(`✗ ${session.workspace}/${session.sessionDir}`)
    lines.push(`  file: ${session.file}`)
    lines.push(`  events: ${session.eventCount}, version: ${String(session.version ?? '?')}`)
    for (const issue of session.issues.slice(0, 8)) {
      lines.push(`  - seq ${String(issue.seq ?? '?')} ${issue.type ?? ''}: ${issue.code}: ${issue.detail}`)
    }
    if (session.issues.length > 8) lines.push(`  … ${session.issues.length - 8} more`)
  }
  if (suspect.length === 0) lines.push('all scanned generations match the supported reader rules')
  return lines.join('\n')
}

/**
 * Report whether one path exists and is a directory.
 * @param path - Absolute path.
 * @returns True when stat reports a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
