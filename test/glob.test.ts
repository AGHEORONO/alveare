import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePattern as n, overlaps, matches } from '../src/core/glob.ts';

test('normalizePattern', () => {
  assert.equal(n('./src\\API\\x.ts'), 'src/API/x.ts', 'keeps case for display');
  assert.equal(n('src/api/'), 'src/api/**');
  assert.equal(n('/src//a.ts'), 'src/a.ts');
  assert.equal(n('.'), '**');
});

test('matches', () => {
  assert.ok(matches('src/**', 'src/a/b.ts'));
  assert.ok(matches('src/**/*.ts', 'src/a.ts'));
  assert.ok(matches('src/**/*.ts', 'src/a/b/c.ts'));
  assert.ok(!matches('src/*.ts', 'src/a/b.ts'));
  assert.ok(matches('src/?.ts', 'src/a.ts'));
  assert.ok(!matches('src/a.ts', 'src/a.tsx'));
  assert.ok(matches('a.b', 'a.b') && !matches('a.b*', 'axb'));
});

test('overlaps', () => {
  assert.ok(overlaps('src/a.ts', 'src/a.ts'));
  assert.ok(!overlaps('src/a.ts', 'src/b.ts'));
  assert.ok(overlaps('src/**', 'src/a.ts'));
  assert.ok(overlaps('src/a.ts', 'src/**'));
  assert.ok(!overlaps('src/api/**', 'src/ui/x.ts'));
  assert.ok(overlaps('src/**', 'src/api/*.ts'), 'glob vs glob, nested');
  assert.ok(!overlaps('src/api/**', 'src/ui/**'), 'glob vs glob, disjoint');
  assert.ok(overlaps('**', 'anything/at/all.ts'));
  assert.ok(overlaps('README.md', 'readme.md'), 'case-insensitive');
  assert.ok(overlaps('SRC/**', 'src/a.ts') && overlaps('Src/*', 'src/**'));
});
