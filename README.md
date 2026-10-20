# Job Vaccum

A local desktop app for macOS on Apple Silicon that brings job search, review, and shortlisting into one place. Built with Electron, React, TypeScript, Python, and SQLite.

Currently available:

- Configure and run job searches through JobSpy, with rule-based filtering, deduplication, and run history.
- Browse, filter, and sort jobs, and read full job descriptions.
- Score jobs automatically or on demand using a configurable AI model and scoring rubric.
- Maintain a shortlist with application statuses and notes, and export jobs as CSV.

Under active development. Scheduled runs, AI-assisted setup, and advanced proxy support are still planned. This is not yet a signed production release. Applications are submitted outside the app.

## Technology and structure

- [Desktop](job-vaccum-app/desktop/README.md): Electron, React, and TypeScript.
- [Backend](job-vaccum-app/backend/README.md): Python, JobSpy, and SQLite, with data stored locally.
- [CI and collaboration](.github/CI.md): Backend tests, frontend type checks and builds, Electron E2E smoke tests, and PR auto-merge.

## Local development

You need a Mac with Apple Silicon, uv, and Node.js. Use the Python and Node versions declared in `job-vaccum-app/.python-version` and `job-vaccum-app/.node-version`. From the repository root, run:

```sh
cd job-vaccum-app/backend
uv sync --locked --python "$(cat ../.python-version)"
cd ../desktop
npm ci
npm run dev
```

See the module READMEs for test and packaging commands. Automated tests use synthetic data by default and do not require website accounts or paid model services. Dependencies are pinned in the committed lockfiles. Development guidelines are in [AGENTS.md](AGENTS.md), and design documents and progress are in [dev-docs/README.md](dev-docs/README.md).
