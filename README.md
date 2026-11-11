# dsh-session-doctor

Read-only diagnostics for **DeepSeek Harness** (`dsh`) session logs whose stored events violate the reader's
turn/step/scope rules. This is the failure class behind Discussions
[#11971](https://github.com/deepseek-ai/deepseek-harness/discussions/11971),
[#11981](https://github.com/deepseek-ai/deepseek-harness/discussions/11981), and
[#11121](https://github.com/deepseek-ai/deepseek-harness/discussions/11121) (adjacent lifecycle issues):
one bad event coordinate makes a whole stored session unloadable, and the harness reports it as a corrupt session
with no way to inspect which signature caused it.

`session-doctor` decodes each canonical `session.vN.jsonl[.zstd]` generation, replays the rules the current reader
enforces, and names the exact sequence number, event type, and expectation that no longer holds. It never writes to a
session file.

## What it checks

- turn/step coordinate integrity: `turn/start` / `turn/end` / `step/start` / `step/end` nesting and ordering;
- step numbering restarting inside one open turn;
- turn/step-scoped events written outside their scope (`request/header`, `request/context`, `tool/ptc-dispatch-start`,
  `tool/ptc-dispatch`, `assistant/message`, `tool/call`, `tool/result` replacements, …);
- row-level damage: invalid JSON, missing header, non-event rows.

It is a **signature detector aligned with the current V4 reader**, not a full format validator: it does not re-implement
message payload validation, migrations, or compression framing beyond zstd.

## Install

npm publication is pending: `@aturdana/dsh-session-doctor` is not on the registry yet. Use the Git path below.

The unscoped npm name `dsh-session-doctor` is taken by another community package, so this one is scoped as
`@aturdana/dsh-session-doctor`.

From the Git repository (source install; needs git and network):

```sh
dsh plugin --profile web add 'git+https://github.com/aturzone/dsh-session-doctor.git#<commit>'
```

Pin the commit you audited: pnpm installs the default-branch HEAD when the URL has no `#<commit>`.

The first run stops with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` because pnpm blocks the package `prepare` build.
Copy the exact `allowBuilds` key pnpm prints into `$DSH_HOME/profiles/web/pnpm-workspace.yaml`, then re-run the same
`add`:

```yaml
allowBuilds:
  "@aturdana/dsh-session-doctor@https://codeload.github.com/aturzone/dsh-session-doctor/tar.gz/<commit>": true
```

That allowance executes this package's install-time build, so only install a commit whose source you trust. Once
published, the registry path is `dsh plugin --profile web add @aturdana/dsh-session-doctor@next`.

## Use as a dsh bundle

The bundle inserts one plugin row; the plugin registers the model-facing `session_doctor` tool, which scans
`$DSH_HOME/sessions` (or a `sessionsRoot` argument) and returns the same report as the CLI. Read-only.

### Development overlay (from a checkout)

```yaml
# overlay.yml
- insert:
    - id: session-doctor-dev
      name: /absolute/path/to/dsh-session-doctor/src/index.ts
```

```sh
pnpm dsh web --patch ./overlay.yml
```

## Use as a CLI

```sh
session-doctor [--home <DSH_HOME>] [--sessions-root <dir>] [--json] [--all-generations]
```

- defaults to `$DSH_HOME/sessions`, then `~/.dsh/sessions`;
- audits the highest canonical generation per session by default; `--all-generations` also validates
  every retained predecessor (`session.v3.jsonl` beside `session.v4.jsonl`, …);
- accepts either the sessions root or one workspace bucket (`--sessions-root .../sessions/--my-project--`);
- exit codes: `0` clean, `1` suspect generations found, `2` usage/I/O failure. `--json` prints the structured report.

## Example output

```text
session root: /home/me/.dsh/sessions
sessions: 2 scanned, 1 with reader-incompatible signatures

✗ --demo--/session-bad
  file: …/--demo--/session-bad/session.v4.jsonl
  events: 4, version: 4
  - seq 2 tool/ptc-dispatch-start: turn-scope: tool/ptc-dispatch-start outside an open turn
  - seq 3 tool/ptc-dispatch: turn-scope: tool/ptc-dispatch outside an open turn
```

## Limitations

- Only the highest canonical generation per session directory is scanned unless `--all-generations` is passed;
  retained predecessors are otherwise invisible by design.
- No repair or quarantine yet. The tool names the defect; moving a corrupt generation aside stays a manual decision.
- The rules mirror the V4 reader at the time of release. A future format version needs this project updated in step
  with `session-format-vN-to-vN+1`.

## Development

```sh
pnpm exec vitest run --root .
```

Node ≥ 24.9 (uses `node:zlib` zstd). MIT.
