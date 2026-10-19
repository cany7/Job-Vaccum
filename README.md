# Job Vaccum

A local desktop app for macOS on Apple Silicon. Browse and filter jobs, organize an application shortlist, and export it as CSV. Applications are submitted outside the app.

The project is under development. Job lists, details, filtering and sorting, application statuses and notes, and a JobSpy search backend are available. The search interface, AI scoring, and scheduled runs are planned for later development. This is not yet a signed production release.

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

See the module READMEs for test and packaging commands. Automated tests use synthetic data by default and do not require website accounts or paid model services. Dependencies are pinned in the committed lockfiles. Local development guidelines and design documents are maintained separately and are not distributed with the repository.
