// Only model I/O is synthetic; run the production main, preload and Python service.
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../../dist/electron/main/backend.js');
const { Backend } = require(modulePath);
require(modulePath).Backend = class extends Backend {
  constructor(options) {
    super({ ...options, args: [path.resolve(__dirname, '../../../backend/tests/drafts_peer.py')] });
  }
};
require('../../dist/electron/main/index.js');
