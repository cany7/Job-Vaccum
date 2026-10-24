// Test-only dependency injection; production main and all HTTP/IPC code run unchanged.
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../../dist/electron/main/backend.js');
const { Backend } = require(modulePath);
require(modulePath).Backend = class extends Backend {
  constructor(options) {
    super({ ...options, args: [path.resolve(__dirname, '../../../backend/tests/mcp_peer.py'), '--enable-dev-commands'] });
    global.m8Backend = this;
  }
};
require('../../dist/electron/main/index.js');
