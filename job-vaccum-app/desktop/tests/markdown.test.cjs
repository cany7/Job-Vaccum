const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// GHSA-gfr2-rv44-r23c affects the JD renderer even with raw HTML disabled.
// Isolate parsing so a vulnerable version fails promptly instead of hanging tests.
const render = `
  const assert = require('node:assert/strict');
  const { readFileSync } = require('node:fs');
  const MarkdownIt = require('markdown-it');
  const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false }).disable(['image']);
  const start = performance.now();
  const html = markdown.render(readFileSync(0, 'utf8'));
  assert(html.includes('<h2>Still responsive</h2>'));
  console.log(JSON.stringify({ milliseconds: performance.now() - start }));
`;

for (const [name, input] of [
  ['unclosed link title', '[a]: /u "' + 'x\n'.repeat(200_000)],
  ['unclosed link label', '[' + 'a\n'.repeat(200_000)],
]) {
  test(`JD Markdown renders a large ${name} without blocking`, () => {
    const output = execFileSync(process.execPath, ['-e', render], {
      cwd: require('node:path').resolve(__dirname, '..'),
      input: input + '\n\n## Still responsive\n',
      encoding: 'utf8', timeout: 5_000, maxBuffer: 8192,
    });
    assert(JSON.parse(output).milliseconds < 5_000);
  });
}
