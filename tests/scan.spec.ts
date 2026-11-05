/** Fixture and regression coverage for the read-only session signature scanner. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeEvents, decodeSessionFile, formatReport, scanSessions } from '../src/scan.ts'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-doctor-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function header(version = 4): string {
  return JSON.stringify({ type: 'session', version, id: 'session-test', createdAt: 1, isSeeded: false, delegationDepth: 0 })
}

function rows(...events: readonly Record<string, unknown>[]): string {
  return [header(), ...events.map((event, seq) => JSON.stringify({ seq, time: seq + 1, ...event }))].join('\n') + '\n'
}

function writeSession(root: string, workspace: string, id: string, name: string, content: string | Uint8Array): string {
  const dir = join(root, workspace, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
  return join(dir, name)
}

describe('analyzeEvents', () => {
  it('accepts a clean turn with one step', () => {
    const events = [
      { type: 'turn/start', seq: 0, turn: 1 },
      { type: 'step/start', seq: 1, turn: 1, step: 1 },
      { type: 'tool/call', seq: 2 },
      { type: 'step/end', seq: 3, turn: 1, step: 1 },
      { type: 'turn/end', seq: 4, turn: 1 },
    ]
    expect(analyzeEvents(events)).toEqual([])
  })

  it('flags PTC dispatch records written after the turn closed', () => {
    const issues = analyzeEvents([
      { type: 'turn/start', seq: 0, turn: 1 },
      { type: 'turn/end', seq: 1, turn: 1 },
      { type: 'tool/ptc-dispatch-start', seq: 2 },
      { type: 'tool/ptc-dispatch', seq: 3 },
    ])
    expect(issues.map(issue => issue.code)).toEqual(['turn-scope', 'turn-scope'])
    expect(issues[0]?.seq).toBe(2)
    expect(issues[0]?.detail).toContain('outside an open turn')
  })

  it('flags a rebuild of the step counter inside one turn', () => {
    const issues = analyzeEvents([
      { type: 'turn/start', seq: 0, turn: 1 },
      { type: 'step/start', seq: 1, turn: 1, step: 1 },
      { type: 'step/end', seq: 2, turn: 1, step: 1 },
      { type: 'step/start', seq: 3, turn: 1, step: 1 },
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('step-numbering')
    expect(issues[0]?.detail).toContain('expects step 2')
  })

  it('flags replacement tool results outside a turn', () => {
    const issues = analyzeEvents([{ type: 'tool/result', seq: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }])
    expect(issues[0]?.code).toBe('turn-scope')
  })
})

describe('decodeSessionFile', () => {
  it('decodes an uncompressed generation into header and events', () => {
    const file = join(scratch(), 'session.v4.jsonl')
    const bytes = new TextEncoder().encode(rows({ type: 'turn/start', turn: 1 }))
    writeFileSync(file, bytes)
    const decoded = decodeSessionFile(file, bytes)
    expect(decoded.header?.id).toBe('session-test')
    expect(decoded.events).toHaveLength(1)
    expect(decoded.issues).toEqual([])
  })

  it('decodes a zstd generation', () => {
    const file = join(scratch(), 'session.v4.jsonl.zstd')
    const bytes = zstdCompressSync(Buffer.from(rows({ type: 'turn/start', turn: 1 })))
    writeFileSync(file, bytes)
    const decoded = decodeSessionFile(file, new Uint8Array(bytes))
    expect(decoded.header?.version).toBe(4)
    expect(decoded.issues).toEqual([])
  })

  it('reports invalid rows and a missing header', () => {
    const file = join(scratch(), 'session.v4.jsonl')
    const bytes = new TextEncoder().encode('{"type":"turn/start","seq":0}\nnot json\n')
    writeFileSync(file, bytes)
    const decoded = decodeSessionFile(file, bytes)
    expect(decoded.issues.map(issue => issue.code)).toContain('missing-header')
    expect(decoded.issues.map(issue => issue.code)).toContain('invalid-row')
  })
})

describe('scanSessions', () => {
  it('scans every workspace and only the highest generation per session', async () => {
    const home = scratch()
    const root = join(home, 'sessions')
    writeSession(root, '--work--', 'clean', 'session.v4.jsonl.zstd', zstdCompressSync(Buffer.from(rows(
      { type: 'turn/start', turn: 1 }, { type: 'turn/end', turn: 1 },
    ))))
    writeSession(root, '--work--', 'corrupt', 'session.v3.jsonl', rows({ type: 'turn/start', turn: 1 }))
    const corrupt = writeSession(root, '--work--', 'corrupt', 'session.v4.jsonl', rows(
      { type: 'turn/start', turn: 1 }, { type: 'turn/end', turn: 1 }, { type: 'tool/ptc-dispatch-start' },
    ))
    const result = await scanSessions({ sessionsRoot: root })
    expect(result.sessions).toHaveLength(2)
    const target = result.sessions.find(session => session.sessionDir === 'corrupt')
    expect(target?.file).toBe(corrupt)
    expect(target?.issues[0]?.code).toBe('turn-scope')
    const report = formatReport(result)
    expect(report).toContain('sessions: 2 scanned, 1 with reader-incompatible signatures')
  })

  it('audits every retained generation only when requested', async () => {
    const home = scratch()
    const root = join(home, 'sessions')
    writeSession(root, '--work--', 'multi', 'session.v3.jsonl', rows(
      { type: 'turn/start', turn: 1 }, { type: 'turn/end', turn: 1 }, { type: 'tool/ptc-dispatch-start' },
    ))
    writeSession(root, '--work--', 'multi', 'session.v4.jsonl', rows(
      { type: 'turn/start', turn: 1 }, { type: 'turn/end', turn: 1 },
    ))
    const highest = await scanSessions({ sessionsRoot: root })
    expect(highest.sessions.map(session => session.file.split('/').pop())).toEqual(['session.v4.jsonl'])
    const all = await scanSessions({ sessionsRoot: root, allGenerations: true })
    expect(all.sessions).toHaveLength(2)
    expect(all.sessions.filter(session => session.issues.length > 0).map(session => session.file.split('/').pop()))
      .toEqual(['session.v3.jsonl'])
  })

  it('returns an empty result for a missing sessions root', async () => {
    const result = await scanSessions({ sessionsRoot: join(scratch(), 'missing') })
    expect(result.sessions).toEqual([])
    expect(formatReport(result)).toContain('0 with reader-incompatible signatures')
  })
})
