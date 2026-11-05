/**
 * Model-facing `session_doctor` tool: scans stored session generations and reports
 * reader-incompatible signatures without modifying any file.
 * @module dsh-session-doctor/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatReport, scanSessions } from './scan.ts'

export const name = 'session-doctor'
export const inject = ['tools']

/**
 * Register the diagnostics tool.
 * @param ctx - Plugin context with the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'session_doctor',
    description:
      'Scan stored Harness session logs for reader-incompatible turn/step/scope signatures '
      + 'and report the affected sessions. Read-only: never modifies session files.',
    parameters: {
      sessionsRoot: {
        type: 'string',
        description: 'Optional absolute sessions directory; defaults to $DSH_HOME/sessions.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: { sessionsRoot?: string }) {
      const result = await scanSessions(args.sessionsRoot === undefined ? {} : { sessionsRoot: args.sessionsRoot })
      return formatReport(result)
    },
  }))
}
