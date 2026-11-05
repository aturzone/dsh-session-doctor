#!/usr/bin/env node
/**
 * `session-doctor` CLI: read-only report of stored Harness session generations that
 * violate the current reader's turn/step/scope rules.
 * @module dsh-session-doctor/cli
 */

import { formatReport, scanSessions, type ScanOptions } from './scan.ts'

interface Args extends ScanOptions {
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let home: string | undefined
  let sessionsRoot: string | undefined
  let json = false
  let allGenerations = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--home': home = argv[++index]; break
      case '--sessions-root': sessionsRoot = argv[++index]; break
      case '--json': json = true; break
      case '--all-generations': allGenerations = true; break
      case '-h': case '--help':
        process.stdout.write(usage())
        process.exit(0)
      default:
        process.stderr.write(`session-doctor: unknown argument ${String(arg)}\n\n${usage()}`)
        process.exit(2)
    }
  }
  return { home, sessionsRoot, json, ...allGenerations ? { allGenerations: true } : {} }
}

function usage(): string {
  return [
    'Usage: session-doctor [--home <DSH_HOME>] [--sessions-root <dir>] [--json] [--all-generations]',
    '',
    'Scans <DSH_HOME>/sessions (default $DSH_HOME or ~/.dsh) and reports session',
    'generations whose stored events violate the reader turn/step/scope rules.',
    'By default only the highest generation per session is audited; --all-generations',
    'also validates every retained predecessor.',
    'Exit codes: 0 clean, 1 suspect generations found, 2 usage or I/O failure.',
    '',
  ].join('\n')
}

const args = parseArgs(process.argv.slice(2))
try {
  const result = await scanSessions(args)
  if (args.json) process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
  else process.stdout.write(`${formatReport(result)}\n`)
  process.exit(result.sessions.some(session => session.issues.length > 0) ? 1 : 0)
} catch (error) {
  process.stderr.write(`session-doctor: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
