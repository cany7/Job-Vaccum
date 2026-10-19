const path = require('node:path');
module.exports = {
  testDir: 'tests/e2e', workers: 1, timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: path.resolve(__dirname, '../../../tmp/job-vaccum-app/e2e-results'),
  reporter: 'list',
};
