# CI and automatic merging

`workflows/ci.yml` runs on pull requests targeting `main`, pushes to `main`,
and manual dispatch. PR checks run on GitHub's test merge commit, using
`macos-15` (Apple Silicon), the declared Node/Python versions and locked
dependencies. No application credentials or real scraping services are needed.

Required check names:

| Check | Scope |
| --- | --- |
| Backend | All pytest tests |
| Frontend | TypeScript checks, production build, Node tests |
| Desktop E2E | Five existing tests tagged `@smoke`: app lifecycle and real backend diagnostics; Jobs selection and adding to Shortlist; backend crash; business persistence/export; M2 configuration and run queries |

The jobs run independently. A newer run cancels the previous run for the same
PR. Tests are not retried automatically. JUnit reports and available E2E
screenshots/results are retained for seven days; test databases are not uploaded.
Early startup failures may have only the Actions console log.

For full E2E coverage, use **Actions → CI → Run workflow**, select the branch
and enable `full_e2e`, or run:

```sh
gh workflow run ci.yml --ref codex/dev -f full_e2e=true
```

Manual dispatch becomes available after the workflow reaches the default branch.
Full E2E and installed-package/UI acceptance remain release-stage checks;
the five PR smoke tests are not a substitute for those checks.

## One-time GitHub setup

1. Push this configuration and open its initial PR. Verify all three jobs on
   GitHub before relying on automatic merging. Local checks do not verify a
   hosted runner or repository settings.
2. In **Settings → Branches**, add a protection rule for exactly `main`:
   - Require a pull request before merging, without requiring a human approval.
   - Require the three status checks above, selecting the GitHub Actions checks
     after their first run.
   - Require branches to be up to date before merging.
   - Do not allow bypassing these settings; do not allow force pushes or deletion.
3. In **Settings → General → Pull Requests**, enable **Allow auto-merge** and
   **Allow merge commits**. Leave **Automatically delete head branches** off
   because `codex/dev` and `claude/dev-env` are reused.
4. Merge the initial configuration PR after its hosted checks pass. Future PRs
   can use auto-merge as described below.

These repository settings are not applied by the workflow file. Do not use
`gh pr merge --auto` as a substitute for required checks: an already mergeable
PR can merge immediately. Configure protection before enabling auto-merge.

## Each development change

The local development agent uses its existing authenticated GitHub CLI. After
the authorized work and local validation, push the development branch, create
a PR to `main` if none is open, and enable auto-merge. Example for Codex:

```sh
git push origin codex/dev
gh pr create --base main --head codex/dev --title 'Describe the change' --body-file /path/to/pr-body.md
gh pr merge --auto --merge <PR-number>
```

For Claude, substitute `claude/dev-env`. If a PR is already open, push updates
to it instead of creating another. Do not use `--admin` or `--delete-branch`.
Creating the PR and enabling auto-merge are local-agent steps, not automatic
effects of `git push` or this CI workflow. They can be performed as one
authorized delivery task, without a separate manual click on GitHub.

If `main` advances, update the affected branch in its own working directory:

```sh
git fetch origin
git merge origin/main
# Resolve any conflicts, run the relevant local checks, then push the branch.
```

This triggers fresh PR checks. Conflicts and failed tests block merging and
require a fix; there is no unattended conflict resolution. After merging,
both development branches should fetch and merge `origin/main` before their
next change. No directory needs to check out `main`.

The CI token has read-only repository permissions. No PAT, GitHub App, automatic
approval bot or privileged `pull_request_target` workflow is added. Creating
PRs through an Actions `GITHUB_TOKEN` can require approval before subsequent
CI runs; using the local CLI avoids that extra automation credential flow.

References: [GitHub auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request),
[workflow token event behavior](https://docs.github.com/en/actions/concepts/security/github_token),
[runner images](https://github.com/actions/runner-images).
