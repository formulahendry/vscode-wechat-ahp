import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { SourceMap } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.cwd();
const exec = promisify(execFile);
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));

async function fixture(t) {
  const directory = await mkdtemp(join(root, '.test-build', 'development-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'src'));
  await copyFile(join(root, 'esbuild.mjs'), join(directory, 'esbuild.mjs'));
  await copyFile(join(root, 'scripts', 'licenses.mjs'), join(directory, 'scripts', 'licenses.mjs'));
  const source = join(directory, 'src', 'extension.ts');
  await writeFile(source, 'export function activate(): string {\n  return "debug-fixture-first";\n}\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, source, bundle: join(directory, 'dist', 'extension.cjs') };
}

test('F5 resolves the manifest entrypoint and both watch tasks without extra matcher extensions', async () => {
  const manifest = await json('package.json');
  const launch = await json(join('.vscode', 'launch.json'));
  const tasks = (await json(join('.vscode', 'tasks.json'))).tasks;
  const configuration = launch.configurations[0];
  assert.equal(configuration.type, 'extensionHost');
  assert.equal(configuration.request, 'launch');
  assert.equal(configuration.runtimeExecutable, '${execPath}');
  assert.ok(configuration.args.includes('--extensionDevelopmentPath=${workspaceFolder}'));
  assert.ok(configuration.args.includes('--new-window'));
  assert.ok(configuration.args.includes('${workspaceFolder}'));
  assert.equal(configuration.sourceMaps, true);
  assert.equal(resolve(configuration.outFiles[0].replace('${workspaceFolder}', root).replaceAll('${pathSeparator}', sep)), resolve(root, manifest.main));
  assert.equal(configuration.preLaunchTask, '${defaultBuildTask}');
  const defaultTask = tasks.find(task => task.group?.isDefault);
  assert.equal(defaultTask.label, 'watch');
  assert.equal(defaultTask.dependsOrder, 'parallel');
  for (const dependency of defaultTask.dependsOn) {
    const task = tasks.find(task => task.label === dependency);
    assert.equal(task.isBackground, true);
    assert.ok(manifest.scripts[task.script]);
    if (task.script === 'watch:tsc') assert.equal(task.problemMatcher, '$tsc-watch');
    else {
      assert.equal(typeof task.problemMatcher, 'object');
      assert.ok(new RegExp(task.problemMatcher.background.beginsPattern).test('[watch] build started'));
      assert.ok(new RegExp(task.problemMatcher.background.endsPattern).test('[watch] build finished'));
      const issue = new RegExp(task.problemMatcher.pattern.regexp).exec('src\\extension.ts(2,5): error: Invalid input');
      assert.deepEqual(issue.slice(1), ['src\\extension.ts', '2', '5', 'error', 'Invalid input']);
    }
  }
});

test('development build maps executable JavaScript back to TypeScript; production removes debug artifacts', async t => {
  const { directory, source, bundle } = await fixture(t);
  await exec(process.execPath, ['esbuild.mjs'], { cwd: directory });
  const generated = await readFile(bundle, 'utf8');
  const payload = JSON.parse(await readFile(`${bundle}.map`, 'utf8'));
  assert.match(generated, /sourceMappingURL=extension\.cjs\.map/);
  assert.equal(payload.sourcesContent, undefined);
  const lines = generated.split('\n');
  const line = lines.findIndex(value => value.includes('return "debug-fixture-first"'));
  assert.ok(line >= 0);
  const position = new SourceMap(payload).findEntry(line, lines[line].indexOf('return'));
  assert.equal(resolve(dirname(bundle), position.originalSource), source);
  assert.equal(position.originalLine, 1);
  await exec(process.execPath, ['esbuild.mjs', '--production'], { cwd: directory });
  assert.doesNotMatch(await readFile(bundle, 'utf8'), /sourceMappingURL/);
  await assert.rejects(readFile(`${bundle}.map`), { code: 'ENOENT' });
});

test('watch reports initial readiness, rebuilds on save, surfaces errors and recovers', async t => {
  const { directory, source, bundle } = await fixture(t);
  const child = spawn(process.execPath, ['esbuild.mjs', '--watch'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const finished = once(child, 'exit');
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Watch did not become ready: ${output}`);
      await sleep(20);
    }
  };
  const builds = () => output.split('[watch] build finished').length - 1;
  try {
    await wait(() => builds() >= 1);
    assert.match(await readFile(bundle, 'utf8'), /debug-fixture-first/);
    const initial = builds();
    await writeFile(source, 'export function activate(): string {\n  return "debug-fixture-second";\n}\n');
    await wait(() => builds() > initial);
    assert.match(await readFile(bundle, 'utf8'), /debug-fixture-second/);
    const beforeError = builds();
    await writeFile(source, 'export const broken = ;\n');
    await wait(() => builds() > beforeError);
    assert.match(output, /src[\\/]extension\.ts\(1,\d+\): error:/);
    const beforeRecovery = builds();
    await writeFile(source, 'export function activate() { return "debug-fixture-recovered"; }\n');
    await wait(() => builds() > beforeRecovery);
    assert.match(await readFile(bundle, 'utf8'), /debug-fixture-recovered/);
  } finally {
    if (child.exitCode === null) child.kill();
    await finished;
  }
});
