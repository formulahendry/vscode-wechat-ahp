import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { COMMAND_NAMES, MESSAGE_EVENTS, SafeError, Telemetry, telemetryFetcher } from '../.test-build/core.mjs';
import { fakeTelemetry } from './telemetryHelpers.mjs';
import { addNativeViewApi } from './vscodeMock.mjs';

function setup() {
  const fake = fakeTelemetry();
  const warnings = [];
  let time = 100;
  const service = new Telemetry(() => new fake.Reporter(), text => warnings.push(text), () => time);
  return { ...fake, service, warnings, tick: value => { time = value; } };
}

test('event declaration exactly matches the manifest commands and closed result/error contracts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const schema = JSON.parse(await readFile(new URL('../telemetry.json', import.meta.url)));
  const commands = COMMAND_NAMES.map(name => `wechatAHP.${name}`);
  assert.deepEqual(commands.toSorted(), manifest.contributes.commands.map(c => c.command).toSorted());
  assert.deepEqual(Object.keys(schema.events).toSorted(), [
    ...commands, ...commands.map(name => `${name}.error`),
    ...['login', 'connect', 'bindAndConnect'].map(name => `wechatAHP.${name}.result`),
    'extension.activated', 'extension.activation.error', 'wechatAHP.channel.error',
    ...MESSAGE_EVENTS,
  ].toSorted());
  const { service, events } = setup();
  for (const name of COMMAND_NAMES) {
    const attempt = service.command(name);
    attempt.start();
    attempt.fail(new SafeError('PRIVATE', false, 'storage'));
    attempt.fail(new Error('must not double count'));
  }
  for (const event of events) {
    const declared = schema.events[event.name];
    assert.equal(declared.channel, event.channel);
    for (const key of Object.keys(event.properties ?? {})) {
      assert.ok(declared.properties.includes(key));
      assert.ok(schema.fields[key].values.includes(event.properties[key]));
    }
    assert.deepEqual(Object.keys(event.measurements ?? {}), declared.measurements ?? []);
  }
  assert.equal(events.filter(e => e.name.endsWith('.result')).length, 3);
  assert.equal(events.filter(e => e.channel === 'error').length, 20);
  await service.dispose();
});

test('live effective consent and no disabled-event replay', async () => {
  const { service, reporters, events } = setup();
  for (const level of ['off', 'all', 'error', 'crash', 'off', 'all']) {
    reporters[0].telemetryLevel = level;
    const before = events.length;
    service.activated(1);
    service.command('login').fail(new Error('SECRET-RAW-ERROR'));
    const sent = events.slice(before);
    assert.equal(sent.length, level === 'all' ? 4 : level === 'error' ? 1 : 0);
    if (level === 'error') assert.equal(sent[0].channel, 'error');
  }
  await service.dispose();
  const before = events.length;
  service.command('connect').fail(new Error('after shutdown'));
  assert.equal(events.length, before);
});

test('timing starts explicitly, cancellation has no invented duration, results are idempotent and bounded', async () => {
  const { service, events, tick } = setup();
  service.command('login').finish('cancelled');
  assert.equal(events.at(-1).measurements, undefined);
  const attempt = service.command('bindAndConnect');
  attempt.start();
  tick(132.6);
  attempt.finish('success');
  attempt.finish('failed');
  assert.deepEqual(events.at(-1), {
    channel: 'usage', name: 'wechatAHP.bindAndConnect.result',
    properties: { outcome: 'success' }, measurements: { duration_ms: 33 },
  });
  attempt.fail(new Error('cleanup failed after the success milestone'));
  attempt.fail(new Error('duplicate'));
  assert.equal(events.filter(e => e.name === 'wechatAHP.bindAndConnect.error').length, 1);
  assert.equal(events.filter(e => e.name === 'wechatAHP.bindAndConnect.result').length, 1);
  assert.equal(events.some(e => e.name.startsWith('wechatAHP.connect')), false);
  service.activated(Infinity);
  assert.equal(events.at(-1).measurements, undefined);
  service.activated(-1);
  assert.equal(events.at(-1).measurements, undefined);
  service.activated(1e20);
  assert.equal(events.at(-1).measurements.duration_ms, 86400000);
  await service.dispose();
});

test('private sentinels and forged event/category/outcome strings cannot cross the adapter boundary', async () => {
  const { service, events, warnings } = setup();
  const privateValues = [
    'SECRET-BOT-TOKEN', 'PRIVATE-OWNER@wechat', 'PRIVATE-MESSAGE-BODY',
    'ahp-chat:/PRIVATE-CHAT', 'C:\\private\\repo', '127.0.0.1:9999?tkn=PRIVATE',
    'https://weixin.qq.com/PRIVATE-QR', 'PRIVATE-STACK',
  ];
  for (const value of privateValues) {
    service.command(value).fail(new Error(value));
    service.error(value, new Error(value));
    service.command('login').finish(value);
    service.command('connect').fail(new SafeError(value, false, value));
  }
  const payload = JSON.stringify(events);
  for (const value of privateValues) assert.ok(!payload.includes(value));
  for (const event of events.filter(e => e.channel === 'error')) {
    assert.deepEqual(event.properties, { error_category: 'unexpected' });
  }
  assert.equal(warnings.length, 1);
  assert.ok(!privateValues.some(value => warnings[0].includes(value)));
  await service.dispose();
});

test('factory, send, network and disposal failures remain nonfatal with a fixed one-time warning', async () => {
  const warnings = [];
  const failed = new Telemetry(() => { throw new Error('PRIVATE'); }, text => warnings.push(text));
  failed.activated(1);
  await failed.dispose();
  const { service, reporters, warnings: sends } = setup();
  reporters[0].sendTelemetryEvent = () => { throw new Error('PRIVATE'); };
  reporters[0].dispose = async () => { throw new Error('PRIVATE'); };
  service.activated(1);
  service.activated(1);
  await service.dispose();
  await service.dispose();
  assert.equal(warnings.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(warnings[0], sends[0]);
  const hung = setup();
  hung.reporters[0].dispose = () => new Promise(() => {});
  await hung.service.dispose();
  assert.equal(hung.warnings.length, 1);
  let networkWarnings = 0;
  const fetcher = telemetryFetcher(() => { networkWarnings++; }, async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    throw new Error('PRIVATE-NETWORK-ERROR');
  });
  await assert.rejects(fetcher('https://example.invalid', { method: 'POST' }), /^Error: Telemetry request failed\.$/);
  assert.equal(networkWarnings, 1);
});

test('official SDK live logger levels and serialized wire payload stay offline with a fake key and custom fetcher', async () => {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const original = Module._load;
  const https = require('node:https');
  const originalRequest = https.request;
  let forbiddenRequests = 0;
  https.request = () => { forbiddenRequests++; throw new Error('Unexpected real HTTPS request'); };
  const stub = { env: { machineId: 'SDK-MACHINE', sessionId: 'SDK-SESSION' }, window: {}, commands: {} };
  addNativeViewApi(stub);
  const changes = new stub.EventEmitter();
  let level = 'off';
  let loggingOnly = false;
  let sender;
  let initialization;
  stub.env.createTelemetryLogger = (value, options) => {
    sender = value;
    initialization = options;
    const log = (name, data) => {
      if (!loggingOnly) sender.sendEventData(`wechat-ahp/${name}`, {
        properties: { ...options.additionalCommonProperties, ...data.properties }, measurements: data.measurements,
      });
    };
    return {
      get isUsageEnabled() { return level === 'all'; },
      get isErrorsEnabled() { return level === 'all' || level === 'error'; },
      onDidChangeEnableStates: changes.event,
      logUsage(name, data) { if (level === 'all') log(name, data); },
      logError(name, data) { if (level === 'all' || level === 'error') log(name, data); },
      dispose() { changes.dispose(); },
    };
  };
  const packets = [];
  let service;
  let reporter;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return stub;
      return original.call(this, request, parent, isMain);
    };
    const { TelemetryReporter } = require('@vscode/extension-telemetry');
    Module._load = original;
    service = new Telemetry(() => {
      reporter = new TelemetryReporter('00000000-0000-0000-0000-000000000000', undefined,
        { ignoreUnhandledErrors: true }, async (_url, init) => {
          packets.push(...JSON.parse(init.body));
          return { status: 200, headers: [], text: async () => '' };
        });
      return reporter;
    }, assert.fail);
    service.command('login').finish('cancelled');
    assert.equal(packets.length, 0);
    level = 'error'; changes.fire();
    assert.equal(reporter.telemetryLevel, 'error');
    service.command('connect').fail(new SafeError('PRIVATE-MESSAGE', false, 'auth'));
    service.messages.result('wechatUser', 'uncertain', new SafeError('PRIVATE-MESSAGE', false, 'transport'));
    level = 'all'; changes.fire();
    service.command('focus');
    service.messages.input('wechatUser');
    service.messages.input('vscodeUser');
    service.messages.completed(true);
    service.messages.result('wechatUser', 'host_accepted');
    service.messages.result('vscodeUser', 'api_accepted');
    service.messages.result('agentReply', 'uncertain', new SafeError('PRIVATE-TYPING-TICKET', false, 'delivery'));
    loggingOnly = true;
    service.command('status').fail(new Error('PRIVATE-LOGGING-ONLY'));
    service.messages.input('wechatUser');
    loggingOnly = false;
    level = 'off'; changes.fire();
    service.command('login').fail(new Error('PRIVATE-STACK'));
    service.messages.completed(false);
    level = 'all'; changes.fire();
    await new Promise(setImmediate);
    await sender.flush();
    await service.dispose();
    assert.equal(initialization.ignoreUnhandledErrors, true);
    assert.deepEqual(packets.map(p => p.data.baseData.name).toSorted(), [
      'wechat-ahp/wechatAHP.connect.error', 'wechat-ahp/wechatAHP.focus',
      ...MESSAGE_EVENTS.map(name => `wechat-ahp/${name}`),
    ].toSorted());
    for (const packet of packets.filter(packet => MESSAGE_EVENTS.some(name => packet.data.baseData.name.endsWith(`/${name}`)))) {
      assert.deepEqual(packet.data.baseData.measurements ?? {}, {});
    }
    const serialized = JSON.stringify(packets);
    for (const value of ['PRIVATE-MESSAGE', 'PRIVATE-STACK', 'PRIVATE-LOGGING-ONLY', 'PRIVATE-TYPING-TICKET', '37e731fc-21aa-4ee5-987a-c3eea6995bb9']) {
      assert.ok(!serialized.includes(value));
    }
    assert.ok(serialized.includes('SDK-MACHINE'));
    assert.ok(serialized.includes('SDK-SESSION'));
    assert.equal(forbiddenRequests, 0);
  } finally {
    await service?.dispose();
    Module._load = original;
    https.request = originalRequest;
  }
});
