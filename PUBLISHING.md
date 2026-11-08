# Publishing runbook

Status: **GitHub executed 2026-11-05** (repo `aturzone/dsh-session-doctor`, topics `dsh-plugin`,
`deepseek-harness`, `session-diagnostics`); **npm pending** — requires interactive `npm login` or an
`NPM_TOKEN`. Steps below are retained as the executed record.

## 1. Create the repository

```sh
cd .tools/plugins/dsh-session-doctor
git init -b main
git add -A
git commit -m "feat: session log diagnostics plugin for DeepSeek Harness"
gh repo create aturzone/dsh-session-doctor --public --source=. --remote=origin \
  --description "Read-only diagnostics for corrupt DeepSeek Harness session logs" --push
gh repo edit --add-topic dsh-plugin --add-topic deepseek-harness
```

Package metadata (`repository`, `homepage`, `bugs`) is set from the final URL and committed.

## 1b. npm name collision (2026-11-08)

The unscoped name `dsh-session-doctor` is already on npm (imtokenxinluo, since 2026-09, v0.2.3). This package
therefore publishes as **`@aturzone/dsh-session-doctor`** with `publishConfig.access = public`; all install docs use
the scoped name. Publishing still needs an npm token with 2FA bypass (owner deferred on 2026-11-06).

## 2. Verify the published path before announcing

- CI green (typecheck, 9 tests, build).
- Fresh-install rehearsal against a scratch profile (npm/Git, not `link:`):

  ```sh
  DSH_HOME=/tmp/dsh-rehearsal pnpm dsh plugin --profile web add \
    git+https://github.com/aturzone/dsh-session-doctor.git
  DSH_HOME=/tmp/dsh-rehearsal pnpm dsh web --no-open --port 3099
  ```

  Confirm the profile boots with no `startup failed` diagnostics and the bundle appears in `--dump-config`.
  A Git install runs `prepare` (build), so `dist/` stays out of git.

- Optional npm publication (only after the Git path is proven):

  ```sh
  npm publish --tag next --access public
  ```

  `engines.dsh` (>=0.2.2-rc.1 <0.3.0) is what the harness checks on install.

## 3. Announce

Post the draft in `../08-dsh-session-doctor-announcement.md` as a comment on:
- #11971 (writer/runtime turn-scope corruption),
- #11981 (duplicate report + second failure class),
and mention it as a diagnostic workaround, not a replacement for the writer fix.

## 4. After publishing

- Add the repository to the session-doctor ledger entry (status: published) and record the URL.
- Watch installs/issues; keep the reader-rule table in sync with `session-format-vN-to-vN+1` changes.
- Consider a plugin index only after npm publication.
