'use strict';

// Markdown tables in messages: the rows under the |---| line are the table's
// body. The pattern used \s after that line, which also ate the line break,
// so only the header became a table and the rows stayed as text.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', 'app-message-content.js'), 'utf8');
const literal = src.match(/const tableRe = (\/.*\/g);/)[1];
const tableRe = () => new RegExp(literal.slice(1, literal.lastIndexOf('/')), 'g');

const bodyOf = (text) => {
  const m = tableRe().exec(text);
  return m ? (m[3] || '').trim().split('\n').filter(Boolean) : null;
};

test('the rows under the separator are the table body', () => {
  assert.deepEqual(bodyOf('| oh | wow |\n|---|---|\n| it even | supports |\n| tables | lmao |'),
    ['| it even | supports |', '| tables | lmao |']);
});

test('spaces after a row or the separator do not break it', () => {
  assert.deepEqual(bodyOf('| a | b |  \n| --- | :---: |  \n| 1 | 2 |'), ['| 1 | 2 |']);
});

test('a header with no rows is still a table, and text after it stays text', () => {
  assert.deepEqual(bodyOf('| a | b |\n|---|---|'), []);
  const m = tableRe().exec('| a | b |\n|---|---|\n| 1 | 2 |\nafter');
  assert.ok(!m[0].includes('after'));
});
