import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import {
  HiddenLineEditor,
  PassphraseError,
  PromptCancelledError,
  promptHidden,
  resolvePassphrase,
} from '../src/passphrase.ts';
import { recordingLogger } from './helpers.ts';

function typed(...chunks: string[]): HiddenLineEditor {
  const editor = new HiddenLineEditor();
  for (const chunk of chunks) editor.feed(chunk);
  return editor;
}

describe('HiddenLineEditor', () => {
  it('handles Backspace (1.x stored it as \\x7f)', () => {
    const editor = typed('ab\u007fc\r');
    assert.equal(editor.done, true);
    assert.equal(editor.value, 'ac');
  });

  it('ignores arrow keys (1.x appended "undefined")', () => {
    assert.equal(typed('ab\u001b[Dc\u001b[A\u001bOB\r').value, 'abc');
  });

  it('ignores an escape sequence split between reads', () => {
    assert.equal(typed('ab\u001b', '[', '1;5D', 'c\r').value, 'abc');
  });

  it('ignores Linux console F-keys and Alt+key', () => {
    assert.equal(typed('a\u001b[[Ab\u001bxc\r').value, 'abc');
  });

  it('keeps a pasted passphrase and drops the bracketed-paste markers', () => {
    assert.equal(typed('\u001b[200~correct horse battery\u001b[201~\r').value, 'correct horse battery');
  });

  it('clears the line with Ctrl+U', () => {
    assert.equal(typed('wrong\u0015right\n').value, 'right');
  });

  it('deletes a whole emoji with one Backspace', () => {
    assert.equal(typed('a🙂\u007f\r').value, 'a');
  });

  it('cancels with Ctrl+C, and with Ctrl+D on an empty line', () => {
    assert.equal(typed('abc\u0003').cancelled, true);
    assert.equal(typed('\u0004').cancelled, true);
    assert.equal(typed('a\u0004').cancelled, false);
  });

  it('echoes stars and erases them', () => {
    const editor = new HiddenLineEditor();
    assert.equal(editor.feed('ab'), '**');
    assert.equal(editor.feed('\u007f'), '\b \b');
  });
});

function fakeTty(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = function (mode: boolean) {
    this.isRaw = mode;
    return this;
  };
  return stream;
}

describe('promptHidden', () => {
  it('reads a line in raw mode and restores the mode', async () => {
    const input = fakeTty();
    const output = new PassThrough();
    const answer = promptHidden('Passphrase: ', input, output);
    input.push('se\u007fecret\r');
    assert.equal(await answer, 'secret');
    assert.equal(input.isRaw, false);
  });

  it('rejects on Ctrl+C', async () => {
    const input = fakeTty();
    const answer = promptHidden('Passphrase: ', input, new PassThrough());
    input.push('\u0003');
    await assert.rejects(answer, PromptCancelledError);
  });
});

describe('resolvePassphrase', () => {
  let dir = '';
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'netpaste-test-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const notTty = () => Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream;

  it('prefers --passphrase-file and strips one final newline', async () => {
    const file = path.join(dir, 'pass');
    await writeFile(file, 'from file with spaces  \n\n', { mode: 0o600 });
    const env = { NETPASTE_PASSPHRASE: 'from env' };
    const result = await resolvePassphrase({ file, env, stdin: notTty(), prompt: new PassThrough(), log: recordingLogger() });
    assert.equal(result, 'from file with spaces  \n');
  });

  it('uses NETPASTE_PASSPHRASE and removes it from the environment', async () => {
    const env: NodeJS.ProcessEnv = { NETPASTE_PASSPHRASE: 'correct horse battery staple' };
    const result = await resolvePassphrase({ env, stdin: notTty(), prompt: new PassThrough(), log: recordingLogger() });
    assert.equal(result, 'correct horse battery staple');
    assert.equal(env.NETPASTE_PASSPHRASE, undefined);
  });

  it('warns about a file that other users can read', { skip: process.platform === 'win32' }, async () => {
    const file = path.join(dir, 'open');
    await writeFile(file, 'correct horse battery staple\n');
    await chmod(file, 0o644);
    const log = recordingLogger();
    await resolvePassphrase({ file, env: {}, stdin: notTty(), prompt: new PassThrough(), log });
    assert.ok(log.has('warn', /chmod 600/));
  });

  it('warns about a short passphrase', async () => {
    const log = recordingLogger();
    await resolvePassphrase({ env: { NETPASTE_PASSPHRASE: 'short' }, stdin: notTty(), prompt: new PassThrough(), log });
    assert.ok(log.has('warn', /short/));
  });

  it('fails without a terminal and without other sources (1.x hung here)', async () => {
    await assert.rejects(resolvePassphrase({ env: {}, stdin: notTty(), prompt: new PassThrough(), log: recordingLogger() }), PassphraseError);
  });

  it('fails on an empty file and on a missing file', async () => {
    const empty = path.join(dir, 'empty');
    await writeFile(empty, '\n', { mode: 0o600 });
    const sources = { env: {}, stdin: notTty(), prompt: new PassThrough(), log: recordingLogger() };
    await assert.rejects(resolvePassphrase({ ...sources, file: empty }), PassphraseError);
    await assert.rejects(resolvePassphrase({ ...sources, file: path.join(dir, 'missing') }), PassphraseError);
  });
});
