import { createRequire } from 'node:module';
import { mockOsForTests } from './helpers.mjs';

export function fakeTelemetry() {
  const events = [];
  const reporters = [];
  class Reporter {
    telemetryLevel = 'all';
    disposed = false;
    constructor(key, replacements, options, fetcher) {
      this.options = options;
      this.fetcher = fetcher;
      reporters.push(this);
    }
    sendTelemetryEvent(name, properties, measurements) { events.push({ channel: 'usage', name, properties, measurements }); }
    sendTelemetryErrorEvent(name, properties, measurements) { events.push({ channel: 'error', name, properties, measurements }); }
    async dispose() { this.beforeDispose?.(); this.disposed = true; }
  }
  return { events, reporters, Reporter };
}

export function loadTelemetryExtension(stub, root, fake) {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const original = Module._load;
  const entry = require.resolve('../.test-build/extension.cjs');
  delete require.cache[entry];
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub;
    if (request === '@vscode/extension-telemetry') return { TelemetryReporter: fake.Reporter };
    if (request === 'node:os') return mockOsForTests(original.call(this, request, parent, isMain), root);
    return original.call(this, request, parent, isMain);
  };
  try { return require(entry); }
  finally { Module._load = original; }
}
