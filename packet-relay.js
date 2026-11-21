import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pipeline } from 'node:stream/promises';

// Bash cannot hold NUL bytes. Keep complete Ember Router frames as hex during handoff.
export async function* readFrames(input) {
  let pending = Buffer.alloc(0);

  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const length = 2 + pending.readUInt16LE(0);
      if (pending.length < length) {
        break;
      }
      yield pending.subarray(0, length);
      pending = pending.subarray(length);
    }
  }

  if (pending.length) {
    throw new Error('Incomplete Ember Router packet');
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  try {
    await pipeline(readFrames(stdin), async function* (frames) {
      for await (const frame of frames) {
        yield frame.toString('hex') + '\n';
      }
    }, stdout);
  } catch (error) {
    stdin.destroy();
    console.error(error.message);
    process.exitCode = 1;
  }
}
