// Self-check for knowledge.recall() (past-interview lookup). Run: node scripts/test-recall.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-recall-'));
const load = Module._load;
Module._load = (req, ...rest) => (req === 'electron' ? { app: { getPath: () => tmp }, nativeImage: {} } : load(req, ...rest));
const knowledge = require('../src/knowledge');
const assert = require('assert');

knowledge.addText('Interview A', 'interview', `Interview: Acme, backend engineer

Q: How would you design a rate limiter for an API?
Topics: system design, rate limiting, Redis
I said: token bucket in memory
Better answer: I'd use a token bucket backed by Redis so limits hold across instances.

Q: Tell me about a conflict with a teammate.
Topics: behavioral, conflict, teamwork
I said: (no answer)
Better answer: On my last project a teammate and I disagreed on the schema; we prototyped both and picked by benchmark.`);
knowledge.addText('Resume', 'text', 'Rate limiter Redis expert'); // not an interview: never recalled

const hits = knowledge.recall('Them: How would you build a rate limiter using Redis?');
assert.strictEqual(hits.length, 1);
assert.ok(hits[0].startsWith('Q: How would you design a rate limiter'));
assert.ok(knowledge.recall('Them: describe a conflict you had with a teammate')[0].includes('conflict with a teammate'));
assert.deepStrictEqual(knowledge.recall('Them: what is your favourite colour'), []);
assert.ok(!knowledge.promptBlock().includes('token bucket')); // interviews stay out of the static prompt

fs.rmSync(tmp, { recursive: true, force: true });
console.log('recall ok');
