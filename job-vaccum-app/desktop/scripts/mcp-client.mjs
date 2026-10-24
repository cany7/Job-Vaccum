// Read-only protocol client example. Run with an absolute App data directory.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Pass the absolute Job Vaccum data directory.');
const { port, token } = JSON.parse(await readFile(path.join(directory, 'mcp.json'), 'utf8'));
const client = new Client({ name: 'job-vaccum-example', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  console.log((await client.listTools()).tools.map(tool => tool.name));
  const result = await client.callTool({ name: 'list_jobs', arguments: { view: 'ids', page: 1 } });
  console.log(result.content[0].text);
} finally { await client.close(); }
