'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unescapeDiscord, forwardedMessage, quoteForwarded } = require('../src/discordText');

test('Discord escapes on plain punctuation are undone (#5811)', () => {
  assert.equal(unescapeDiscord('❤️ 3\\.1K 👁️ 45\\.5K'), '❤️ 3.1K 👁️ 45.5K');
  assert.equal(unescapeDiscord('wait\\! really\\?'), 'wait! really?');
  assert.equal(unescapeDiscord('a \\\\ b'), 'a \\ b');
});

test('a Discord shrug arrives the way Haven writes one', () => {
  assert.equal(unescapeDiscord('¯\\\\_(ツ)_/¯'), '¯\\_(ツ)_/¯');
});

test('escapes that keep text from turning into formatting or pings stay', () => {
  assert.equal(unescapeDiscord('\\*not italic\\* \\@everyone \\_x\\_'), '\\*not italic\\* \\@everyone \\_x\\_');
  assert.equal(unescapeDiscord('1\\. not a list'), '1\\. not a list');
  assert.equal(unescapeDiscord('line\n  12\\. still not'), 'line\n  12\\. still not');
  assert.equal(unescapeDiscord('version 1\\.2'), 'version 1.2');
});

test('backslashes that escape nothing are left alone', () => {
  assert.equal(unescapeDiscord('C:\\Users\\me'), 'C:\\Users\\me');
  assert.equal(unescapeDiscord(null), '');
});

test('a forward is read from its snapshot and quoted', () => {
  assert.equal(forwardedMessage({ content: 'hi' }), null);
  assert.equal(forwardedMessage({ message_snapshots: [] }), null);
  const inner = { content: 'look', attachments: [] };
  assert.equal(forwardedMessage({ content: '', message_snapshots: [{ message: inner }] }), inner);
  assert.equal(quoteForwarded('one\n\ntwo'), '> *Forwarded*\n> one\n>\n> two');
});
