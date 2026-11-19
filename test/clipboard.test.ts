import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClipboardWatcher } from '../src/clipboard.ts';
import { MemoryClipboard, recordingLogger } from './helpers.ts';

function setup(initial = 'initial') {
  const backend = new MemoryClipboard(initial);
  const log = recordingLogger();
  const watcher = new ClipboardWatcher(backend, { intervalMs: 60_000, log });
  const changes: string[] = [];
  watcher.on('change', (text) => changes.push(text));
  return { backend, log, watcher, changes };
}

describe('ClipboardWatcher', () => {
  it('does not report the text that was there at start', async () => {
    const { watcher, changes } = setup();
    await watcher.start();
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, []);
  });

  it('reports a local change once and keeps the text exactly (no trim)', async () => {
    const { backend, watcher, changes } = setup();
    await watcher.start();
    const text = '    indented();\n\tmore();\r\n🙂 trailing  \n\n';
    backend.text = text;
    await watcher.poll();
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, [text]);
  });

  it('does not echo text that came from the network', async () => {
    const { backend, watcher, changes } = setup();
    await watcher.start();
    await watcher.apply('from the network');
    assert.equal(backend.text, 'from the network');
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, []);
  });

  it('sends a local copy made right after a received one (1.x lost it for 2 s)', async () => {
    const { backend, watcher, changes } = setup();
    await watcher.start();
    await watcher.apply('received');
    backend.text = 'copied 100 ms later';
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, ['copied 100 ms later']);
  });

  it('drops a read that overlapped a network write, so the old text is not sent back', async () => {
    const { backend, watcher, changes } = setup('old');
    await watcher.start();
    backend.readDelayMs = 50;
    const polling = watcher.poll(); // reads "old", slowly
    await watcher.apply('new from network');
    await polling;
    backend.readDelayMs = 0;
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, []);
    assert.equal(backend.text, 'new from network');
  });

  it('ignores an empty clipboard (cleared, or an image)', async () => {
    const { backend, watcher, changes } = setup();
    await watcher.start();
    backend.text = '';
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, []);
  });

  it('after a failed first read, takes the first successful read as the baseline', async () => {
    const { backend, watcher, changes } = setup('old private text');
    backend.failReads = true; // for example, the display is not ready yet at login
    await watcher.start();
    await watcher.poll();
    backend.failReads = false;
    await watcher.poll(); // baseline: not sent
    backend.text = 'a real copy';
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, ['a real copy']);
  });

  it('takes a new baseline after stop and start', async () => {
    const { backend, watcher, changes } = setup();
    await watcher.start();
    watcher.stop();
    backend.text = 'copied while no peer was connected';
    await watcher.start();
    await watcher.poll();
    watcher.stop();
    assert.deepEqual(changes, []);
  });

  it('logs a read failure once and the recovery once', async () => {
    const { backend, log, watcher, changes } = setup();
    await watcher.start();
    backend.failReads = true;
    await watcher.poll();
    await watcher.poll();
    backend.failReads = false;
    backend.text = 'after recovery';
    await watcher.poll();
    watcher.stop();
    assert.equal(log.lines.filter((line) => line.level === 'warn').length, 1);
    assert.ok(log.has('info', /readable again/));
    assert.deepEqual(changes, ['after recovery']);
  });

  it('after a failed write it does not send the old text out as new', async () => {
    const { backend, log, watcher, changes } = setup('old');
    await watcher.start();
    backend.failNextWrite = true;
    await watcher.apply('lost');
    await watcher.poll();
    watcher.stop();
    assert.ok(log.has('error', /cannot write/));
    assert.deepEqual(changes, []);
  });

  it('serializes writes in arrival order', async () => {
    const { backend, watcher } = setup();
    await watcher.start();
    await Promise.all([watcher.apply('one'), watcher.apply('two'), watcher.apply('three')]);
    watcher.stop();
    assert.deepEqual(backend.writes, ['one', 'two', 'three']);
    assert.equal(backend.text, 'three');
  });
});
