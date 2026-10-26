import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const packageJsonPath = resolve(repoRoot, 'package.json');
const extensionPath = resolve(repoRoot, '.pi/extensions/superpowers.ts');
const piToolsPath = resolve(repoRoot, 'skills/using-superpowers/references/pi-tools.md');

async function loadExtension() {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    sendMessage() { assert.fail('bootstrap must not enqueue a provider turn'); },
  };
  const mod = await import(pathToFileURL(extensionPath).href + `?cachebust=${Date.now()}-${Math.random()}`);
  mod.default(pi);
  const emit = async (event, data = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, {});
  };
  return { handlers, emit };
}

function startEvent(messageType = 'user') {
  return {
    messageType,
    systemPrompt: 'Base instructions',
    systemPromptOptions: { sections: { existing: 'Keep existing instructions' } },
  };
}

function bootstrapOf(event) {
  return event.systemPromptOptions.sections.superpowers_bootstrap;
}

test('package.json declares a pi package with skills and extension resources', async () => {
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assert.equal(pkg.name, 'superpowers');
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi.skills, ['./skills']);
  assert.deepEqual(pkg.pi.extensions, ['./.pi/extensions/superpowers.ts']);
});

test('resources_discover contributes the bundled skills directory', async () => {
  const { handlers } = await loadExtension();
  const result = await handlers.get('resources_discover')[0]({ type: 'resources_discover', cwd: repoRoot, reason: 'startup' }, {});
  assert.deepEqual(result.skillPaths, [resolve(repoRoot, 'skills')]);
});

test('bootstrap is a structured prompt section without overriding other instructions or queuing messages', async () => {
  const h = await loadExtension();
  const event = startEvent();
  await h.emit('before_agent_start', event);
  assert.match(bootstrapOf(event), /You have superpowers/);
  assert.match(bootstrapOf(event), /Pi tool mapping/);
  assert.match(bootstrapOf(event), /superpowers:using-superpowers bootstrap for pi/);
  assert.equal(event.systemPromptOptions.sections.existing, 'Keep existing instructions');
  assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
  assert.equal(event.systemPrompt, 'Base instructions');
});

test('bootstrap remains byte-identical on later prompts after agent_end', async () => {
  const h = await loadExtension();
  const first = startEvent();
  await h.emit('before_agent_start', first);
  assert.equal(typeof bootstrapOf(first), 'string');
  await h.emit('agent_end');
  const second = startEvent();
  await h.emit('before_agent_start', second);
  assert.deepEqual(second.systemPromptOptions, first.systemPromptOptions);
  assert.equal(h.handlers.has('context'), false, 'no temporary message may be inserted or removed from provider context');
});

test('reload, resume, new sessions and custom-message runs receive the same bootstrap', async () => {
  const original = startEvent();
  await (await loadExtension()).emit('before_agent_start', original);
  assert.equal(typeof bootstrapOf(original), 'string');
  for (const reason of ['reload', 'resume', 'new', 'fork']) {
    const h = await loadExtension();
    await h.emit('session_start', { reason });
    const next = startEvent('custom');
    await h.emit('before_agent_start', next);
    assert.equal(bootstrapOf(next), bootstrapOf(original), reason);
    await h.emit('before_agent_start', next);
    assert.equal(bootstrapOf(next), bootstrapOf(original), 'repeated start must not duplicate content');
  }
});

test('compaction and tree navigation never inject bootstrap-only turns', async () => {
  const h = await loadExtension();
  const first = startEvent();
  await h.emit('before_agent_start', first);
  for (const reason of ['manual', 'threshold', 'overflow']) {
    await h.emit('session_compact', { reason, willRetry: reason === 'overflow' });
    await h.emit('session_tree');
    const next = startEvent();
    await h.emit('before_agent_start', next);
    assert.deepEqual(next.systemPromptOptions, first.systemPromptOptions);
  }
});

test('pi tools reference documents pi-specific mappings', async () => {
  assert.equal(existsSync(piToolsPath), true, 'pi-tools.md should exist');
  const text = await readFile(piToolsPath, 'utf8');
  const rows = text.split('\n').filter((line) => line.startsWith('|'));
  assert.ok(rows.some((row) => /subagent/i.test(row)), 'mapping table documents subagent dispatch');
  assert.ok(rows.some((row) => /todo|task/i.test(row)), 'mapping table documents task tracking');
});
