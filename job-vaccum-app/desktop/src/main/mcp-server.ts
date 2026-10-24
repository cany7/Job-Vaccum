import { createServer } from 'node:http';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-tools';
import type { BusinessCall } from './business-call';

/** Local config only: never exported through IPC, tools, logs or run snapshots. */
export async function startMcp(dataDir: string, call: BusinessCall) {
  const filename = path.join(dataDir, 'mcp.json');
  let config: { port: number; token: string };
  try { config = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid MCP configuration.');
    config = { port: 0, token: randomBytes(32).toString('base64url') };
  }
  if (!config || Object.keys(config).some(k => !['port', 'token'].includes(k))
    || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
    || typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(config.token)) throw new Error('Invalid MCP configuration.');
  const expected = Buffer.from(`Bearer ${config.token}`);
  let port = 0;
  const server = createServer(async (request, response) => {
    const reject = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    };
    // Compare complete authorities, not suffixes. Origin is optional for native
    // clients, but any supplied Origin must be exactly this loopback endpoint.
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host ?? '')) { reject(403, 'Host is not allowed.'); return; }
    if (request.headers.origin !== undefined && !hosts.map(h => `http://${h}`).includes(request.headers.origin)) {
      reject(403, 'Origin is not allowed.'); return;
    }
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reject(401, 'A valid local access token is required.'); return; }
    if (request.url !== '/mcp') { reject(404, 'Endpoint not found.'); return; }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); reject(405, 'Use Streamable HTTP POST; this server is stateless.'); return; }
    const mcp = createMcpServer(call);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) reject(500, 'MCP request failed.');
      else response.end();
      await mcp.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  try {
    // chmod before rewriting an existing file prevents permissive user-created
    // configs from retaining broad access. No token is printed on startup.
    await chmod(filename, 0o600).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await writeFile(filename, JSON.stringify({ ...config, port }) + '\n', { mode: 0o600 });
  } catch { server.close(); server.closeAllConnections(); throw new Error('Could not save MCP configuration.'); }
  return { close() { server.close(); server.closeAllConnections(); } };
}
