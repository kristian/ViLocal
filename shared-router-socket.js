// with a dedicated adapter, ember-router run --socket serves ViLocal directly.
// with a shared adapter, the launcher pauses capture, runs ember-router read
// for one request and reply, then resumes capture. This bridge keeps a single
// socket open for ViLocal across those short-lived router sessions.

import { createServer } from 'node:net';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { readFrames } from './packet-relay.js';

const path = process.argv[2];
if (!path) {
  throw new Error('Usage: node shared-router-socket.js SOCKET_PATH');
}

const lines = createInterface({ input: stdin });
const replies = lines[Symbol.asyncIterator]();
const clients = new Set();
let pending = Promise.resolve();
let closed = false;

function write(stream, data) {
  return new Promise((resolve, reject) => stream.write(data, error => error ? reject(error) : resolve()));
}

async function exchange(frame) {
  // the launcher exchanges one hex line in each direction.
  await write(stdout, frame.toString('hex') + '\n');
  const { value: hex, done } = await replies.next();
  if (done) {
    throw new Error('Shared adapter stopped before replying.');
  }
  const reply = Buffer.from(hex, 'hex');
  if (reply.length < 2 || reply.length * 2 !== hex.length || reply.readUInt16LE() !== reply.length - 2) {
    throw new Error('Invalid shared adapter reply.');
  }
  return reply;
}

const server = createServer({ allowHalfOpen: true }, async socket => {
  clients.add(socket);
  socket.once('close', () => clients.delete(socket));
  socket.on('error', () => socket.destroy());

  try {
    for await (const frame of readFrames(socket)) {
      // each handoff consumes its reply even if the requesting client disconnects.
      const req = pending.then(() => closed || socket.destroyed ? undefined : exchange(frame));
      pending = req.catch(close);
      const reply = await req;
      if (!reply || socket.destroyed) {
        return;
      }
      await write(socket, reply);
    }
    socket.end();
  } catch {
    socket.destroy();
  }
});

function close(error) {
  if (closed) {
    return;
  }
  closed = true;
  if (error) {
    console.error(`Shared router socket: ${error.message}`);
    process.exitCode = 1;
  }

  server.close();
  for (const socket of clients) {
    socket.destroy();
  }
  lines.close();
  stdin.destroy();
}

server.maxConnections = 16;
server.on('error', close);
lines.on('error', close);
stdout.on('error', close);
lines.once('close', () => close());
process.once('SIGINT', () => close());
process.once('SIGTERM', () => close());

server.listen(path);
