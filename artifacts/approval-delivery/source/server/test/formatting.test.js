const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

function harness(t) {
  const dom = new JSDOM('<!doctype html><div id="answer"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'markdown.js']) {
    dom.window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  const source = fs.readFileSync(path.join(root, 'viewer.html'), 'utf8');
  dom.window.eval(source.slice(source.indexOf('function escapeHtml('), source.indexOf('function htmlToPlainText(')));
  const answer = dom.window.document.getElementById('answer');
  return { window: dom.window, answer, render(text) { answer.innerHTML = dom.window.plainTextToHtml(text); return answer; } };
}

test('headings, emphasis, lists and tables render as formatted elements', t => {
  const h = harness(t);
  h.render('# Title\n\nA **bold** and *italic* answer.\n\n1. First\n2. Second\n\n| A | B |\n| --- | --- |\n| One | Two |');
  assert.equal(h.answer.querySelector('h1').textContent, 'Title');
  assert.equal(h.answer.querySelector('strong').textContent, 'bold');
  assert.equal(h.answer.querySelector('em').textContent, 'italic');
  assert.equal(h.answer.querySelectorAll('ol > li').length, 2);
  assert.equal(h.answer.querySelectorAll('table td').length, 2);
});

test('unfinished streamed code stays a code block and preserves indentation', t => {
  const h = harness(t);
  h.render('```python\ndef hello():\n    print("hello")');
  assert.equal(h.answer.querySelector('.code-block code').textContent, 'def hello():\n    print("hello")\n');
  assert.equal(h.answer.querySelector('.code-copy').textContent, 'Copy');
});

test('Markdown never executes embedded HTML or unsafe links', t => {
  const h = harness(t);
  h.render('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n<div onclick="alert(1)">safe</div>');
  assert.equal(h.answer.querySelector('script,img,[onclick],[onerror],a[href^="javascript:"]'), null);
});

test('DOM capture and viewer serialization preserve Markdown and code whitespace', t => {
  const h = harness(t);
  h.answer.innerHTML = '<h2>Heading</h2><p>A <strong>bold</strong> word.</p><ol><li>One</li><li>Two</li></ol><table><tr><th>Name</th></tr><tr><td>Value</td></tr></table><pre><code class="language-python">a = 1\n\n\n    b = 2</code></pre>';
  const text = h.window.LiveMarkdown.fromElement(h.answer);
  assert.match(text, /## Heading/);
  assert.match(text, /\*\*bold\*\*/);
  assert.match(text, /1\. One\n2\. Two/);
  assert.match(text, /\| Name \|\n\| --- \|\n\| Value \|/);
  h.render(text);
  assert.equal(h.answer.querySelector('.code-block code').textContent, 'a = 1\n\n\n    b = 2\n');
});

test('closing a streamed emphasis delimiter reformats the earlier text', t => {
  const h = harness(t);
  h.render('**Working');
  h.render('**Working**');
  assert.equal(h.answer.querySelector('strong').textContent, 'Working');
});
