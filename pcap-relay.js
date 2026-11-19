import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { pipeline } from 'node:stream/promises';

const MAX_RECORD_LENGTH = 16 * 1024 * 1024;

// A capture may be stopped mid-packet during the adapter handoff.
async function* relayCapture(headerPath) {
  const input = stdin[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);

  async function readExact(length) {
    const parts = [];
    let remaining = length;
    while (remaining > 0) {
      if (pending.length === 0) {
        const next = await input.next();
        if (next.done) {
          return;
        }
        pending = next.value;
      }
      const size = Math.min(remaining, pending.length);
      parts.push(pending.subarray(0, size));
      pending = pending.subarray(size);
      remaining -= size;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }

  const header = await readExact(24);
  if (!header) {
    return;
  }

  const magic = header.toString('hex', 0, 4);
  if (magic !== 'd4c3b2a1' && magic !== 'a1b2c3d4') {
    throw new Error('Shared adapter mode requires classic microsecond PCAP');
  }

  const littleEndian = magic === 'd4c3b2a1';
  const read16 = offset => littleEndian ? header.readUInt16LE(offset) : header.readUInt16BE(offset);
  const read32 = (bytes, offset) => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const major = read16(4);
  const minor = read16(6);
  const snapLength = read32(header, 16);
  if (major !== 2 || minor !== 4) {
    throw new Error('Unsupported PCAP version ' + major + '.' + minor);
  }
  if (snapLength === 0) {
    throw new Error('Invalid PCAP snapshot length');
  }

  let previous;
  try {
    previous = await readFile(headerPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (previous) {
    if (!previous.equals(header)) {
      throw new Error('PCAP header changed after restarting capture');
    }
  } else {
    await writeFile(headerPath, header, { flag: 'wx', mode: 0o600 });
    yield header;
  }

  while (true) {
    const record = await readExact(16);
    if (!record) {
      return;
    }
    const length = read32(record, 8);
    if (length > snapLength || length > read32(record, 12) || length > MAX_RECORD_LENGTH) {
      throw new Error('Invalid PCAP record length: ' + length);
    }
    const packet = await readExact(length);
    if (!packet) {
      return;
    }
    yield Buffer.concat([record, packet]);
  }
}

try {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node pcap-relay.js HEADER_FILE');
  }
  // A closed consumer must also release a relay blocked on the capture pipe.
  stdout.once('error', () => stdin.destroy());
  await pipeline(relayCapture(process.argv[2]), stdout);
} catch (error) {
  stdin.destroy();
  console.error(error.message);
  process.exitCode = 1;
}
