'use strict';

/**
 * Kanban → GSD backlog bridge (item 5B). A promoted card must stay on the board
 * linked to its phase (the pipeline walks it through the columns), and a failed
 * commit must leave ROADMAP.md untouched so a retry can't stack duplicates.
 * Needs a real gsd-tools.cjs (project-local or ~/.claude); skips without one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const hasGsd = fs.existsSync(path.join(os.homedir(), '.claude/gsd-core/bin/gsd-tools.cjs'));

function setup(t, { git }) {
  const tmp = (p) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
    t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const home = tmp('md-promote-home-');
  const proj = tmp('md-promote-proj-');
  fs.mkdirSync(path.join(proj, '.planning'));
  fs.writeFileSync(path.join(proj, '.planning/config.json'), '{}\n');
  fs.writeFileSync(path.join(proj, '.planning/ROADMAP.md'), '# Roadmap\n');
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: proj, stdio: 'ignore' });
    g('init', '-q');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
    g('config', 'user.name', 't'); g('config', 'user.email', 't@t'); g('config', 'commit.gpgsign', 'false');
  }
  const hive = new HiveManager(() => home);
  hive.writeTasks([{ id: 'c1', title: 'Fix save button color', status: 'todo', dependsOn: [], priority: 3, createdAt: '2026-10-08T00:00:00.000Z' }]);
  fs.writeFileSync(path.join(hive.root(), 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { cwd: proj } } }));
  return { hive, proj };
}

test('promote keeps the card, links the phase, and refuses a second promote', { skip: !hasGsd }, (t) => {
  const { hive, proj } = setup(t, { git: true });
  const r = hive.promoteTaskToBacklog('c1');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.phase, '999.1');

  const card = hive.tasks().tasks.find((c) => c.id === 'c1');
  assert.equal(card.phase, '999.1');
  assert.match(fs.readFileSync(path.join(proj, '.planning/ROADMAP.md'), 'utf8'), /### Phase 999\.1: Fix save button color \(BACKLOG\)/);

  const again = hive.promoteTaskToBacklog('c1');
  assert.equal(again.ok, false);
  assert.match(again.error, /already promoted/);
});

test('a failed commit rolls back ROADMAP.md and the phase dir', { skip: !hasGsd }, (t) => {
  const { hive, proj } = setup(t, { git: false });
  const r = hive.promoteTaskToBacklog('c1');
  assert.equal(r.ok, false);
  assert.match(r.error, /commit failed/);
  assert.equal(fs.readFileSync(path.join(proj, '.planning/ROADMAP.md'), 'utf8'), '# Roadmap\n');
  assert.deepEqual(fs.existsSync(path.join(proj, '.planning/phases')) ? fs.readdirSync(path.join(proj, '.planning/phases')) : [], []);
  assert.equal(hive.tasks().tasks.find((c) => c.id === 'c1').phase, undefined);
});
