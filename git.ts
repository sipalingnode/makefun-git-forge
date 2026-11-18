// Git smart HTTP: info/refs, upload-pack (protocol v2: ls-refs and fetch) and receive-pack
// (protocol v0 with report-status, side-band-64k and delete-refs, fast-forward-only updates).
//
// The suite speaks this protocol in process with no git binary, so the bytes are the contract:
// pkt-line framing here is exactly what a real git server writes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getForge,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type ObjType,
} from './store.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const FLUSH = Buffer.from('0000', 'latin1');

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([header, data]);
}

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Decode a pkt-line stream; `stopAtFlush` also answers the bytes after the first flush packet. */
function decodePackets(buffer: Buffer, stopAtFlush = false): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      if (stopAtFlush) break;
      throw new Error('not a pkt-line stream');
    }
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      continue;
    }
    if (length < 4 || offset + length - 4 > buffer.length) throw new Error('a pkt-line is truncated');
    packets.push({ kind: 'data', payload: buffer.subarray(offset, offset + length - 4) });
    offset += length - 4;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function textOf(packet: Packet): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_PACK_CAPS = ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', 'multi_ack_detailed', 'agent=makefun-forge/1.0'];
const RECEIVE_PACK_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=makefun-forge/1.0'];

function serviceHeader(service: string): Buffer {
  return Buffer.concat([pkt(`# service=${service}\n`), FLUSH]);
}

const V2_ADVERTISEMENT = Buffer.concat([
  pkt('version 2\n'),
  pkt('agent=makefun-forge/1.0\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow wait-for-done\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The refs a v0 advertisement lists: HEAD first for upload-pack, peeled tags after their tag. */
function v0Advertisement(key: string, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const forge = getForge();
  const repo = forge.getRepo(key.split('/')[0] as string, key.split('/').slice(1).join('/'));
  const heads = forge.branches(key);
  const tags = forge.tags(key);
  const caps = service === 'git-upload-pack' ? [...UPLOAD_PACK_CAPS] : [...RECEIVE_PACK_CAPS];
  if (service === 'git-upload-pack' && repo !== undefined) caps.push(`symref=HEAD:refs/heads/${repo.default_branch}`);
  const headOid = forge.headOid(key);
  const lines: Buffer[] = [];
  let first = true;
  const push = (oid: string, name: string): void => {
    const suffix = first ? `\u0000${caps.join(' ')}` : '';
    first = false;
    lines.push(pkt(`${oid} ${name}${suffix}\n`));
  };
  if (service === 'git-upload-pack') {
    if (headOid === undefined) push(ZERO_OID, 'capabilities^{}');
    else push(headOid, 'HEAD');
  }
  for (const branch of heads) push(branch.oid, `refs/heads/${branch.name}`);
  for (const tag of tags) {
    push(tag.oid, `refs/tags/${tag.name}`);
    const object = forge.getObject(key, tag.oid);
    if (object !== undefined && object.type === 'tag') {
      let target = parseTag(object.data).object;
      for (let depth = 0; depth < 5; depth += 1) {
        const inner = forge.getObject(key, target);
        if (inner === undefined || inner.type !== 'tag') break;
        target = parseTag(inner.data).object;
      }
      lines.push(pkt(`${target} refs/tags/${tag.name}^{}\n`));
    }
  }
  if (first) push(ZERO_OID, 'capabilities^{}');
  return Buffer.concat([...lines, FLUSH]);
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(key: string, packets: Packet[]): Buffer {
  const forge = getForge();
  const repo = forge.getRepo(key.split('/')[0] as string, key.split('/').slice(1).join('/'));
  if (repo === undefined) return FLUSH;
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = textOf(packet);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const target = ` refs/heads/${repo.default_branch}`;
  const headOid = forge.headOid(key);
  if (keep('HEAD')) {
    if (headOid === undefined) out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${target.trim()}` : ''}\n`));
    else out.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${target.trim()}` : ''}\n`));
  }
  for (const branch of forge.branches(key)) {
    const name = `refs/heads/${branch.name}`;
    if (keep(name)) out.push(pkt(`${branch.oid} ${name}\n`));
  }
  for (const tag of forge.tags(key)) {
    const name = `refs/tags/${tag.name}`;
    if (!keep(name)) continue;
    let peelTo = '';
    if (peel) {
      const object = forge.getObject(key, tag.oid);
      if (object !== undefined && object.type === 'tag') {
        let inner = parseTag(object.data).object;
        for (let depth = 0; depth < 5; depth += 1) {
          const next = forge.getObject(key, inner);
          if (next === undefined || next.type !== 'tag') break;
          inner = parseTag(next.data).object;
        }
        peelTo = inner;
      }
    }
    out.push(pkt(`${tag.oid} ${name}${peelTo === '' ? '' : ` peeled:${peelTo}`}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch (v2)

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetch(packets: Packet[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = textOf(packet);
    if (line.startsWith('command=')) continue;
    if (!inArgs) continue;
    if (line.startsWith('want ')) request.wants.push((line.slice(5).trim().split(/\s+/)[0] as string) ?? '');
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) request.depth = value;
    }
  }
  return request;
}

function sidebandPack(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const limit = 60_000;
  for (let offset = 0; offset < data.length; offset += limit) {
    const slice = data.subarray(offset, Math.min(offset + limit, data.length));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pkt(Buffer.from([1])));
  return Buffer.concat(chunks);
}

function fetchV2(key: string, packets: Packet[]): Buffer {
  const forge = getForge();
  const request = parseFetch(packets);
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  const include = new Set<string>();
  const visited = new Set<string>();
  const depth = request.depth;

  const addTreeClosure = (treeOid: string): void => {
    if (include.has(treeOid)) return;
    const object = forge.getObject(key, treeOid);
    if (object === undefined) return;
    include.add(treeOid);
    if (object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '160000') continue;
      addTreeClosure(entry.oid);
    }
  };

  const addCommit = (oid: string, level: number): void => {
    if (visited.has(oid)) return;
    const object = forge.getObject(key, oid);
    if (object === undefined) return;
    visited.add(oid);
    if (object.type === 'tag') {
      include.add(oid);
      addCommit(parseTag(object.data).object, level);
      return;
    }
    if (object.type !== 'commit') return;
    include.add(oid);
    const commit = parseCommit(object.data);
    addTreeClosure(commit.tree);
    if (depth === null) {
      for (const parent of commit.parents) addCommit(parent, level);
      return;
    }
    if (level >= depth) {
      if (commit.parents.length > 0) shallowOut.push(oid);
      return;
    }
    for (const parent of commit.parents) addCommit(parent, level + 1);
  };

  for (const want of request.wants) {
    if (isHex40(want)) addCommit(want, 1);
  }

  // The client's objects: the closure of its haves, but a shallow boundary commit's parents are
  // not held by the client, so the walk stops there (a deepen must then re-send them).
  const haveClosure = new Set<string>();
  const boundarySet = new Set(request.shallow);
  const haveSeen = new Set<string>();
  const haveQueue = [...request.haves];
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop() as string;
    if (haveSeen.has(oid)) continue;
    haveSeen.add(oid);
    const object = forge.getObject(key, oid);
    if (object === undefined) continue;
    haveClosure.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const treeOid of forge.closure(key, [commit.tree])) haveClosure.add(treeOid);
      if (!boundarySet.has(oid)) {
        for (const parent of commit.parents) haveQueue.push(parent);
      }
    } else if (object.type === 'tag') {
      haveQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') haveQueue.push(entry.oid);
      }
    }
  }

  for (const boundary of request.shallow) {
    if (!visited.has(boundary) || shallowOut.includes(boundary)) continue;
    const object = forge.getObject(key, boundary);
    if (object === undefined || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => visited.has(parent))) unshallowOut.push(boundary);
  }

  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of include) {
    if (haveClosure.has(oid)) continue;
    const object = forge.getObject(key, oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);

  const out: Buffer[] = [];
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const oid of shallowOut) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallowOut) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }
  out.push(pkt('packfile\n'));
  out.push(sidebandPack(pack));
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch (v0)

function fetchV0(key: string, packets: Packet[]): Buffer {
  const forge = getForge();
  const wants: string[] = [];
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = textOf(packet);
    if (line.startsWith('want ')) {
      const first = line.slice(5).split(/\s+/)[0];
      if (first !== undefined) wants.push(first);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const haveClosure = new Set<string>();
  for (const oid of forge.closure(key, haves)) haveClosure.add(oid);
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of forge.closure(key, wants)) {
    if (haveClosure.has(oid)) continue;
    const object = forge.getObject(key, oid);
    if (object !== undefined) objects.push(object);
  }
  return Buffer.concat([pkt('NAK\n'), sidebandPack(writePack(objects)), FLUSH]);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(key: string, body: Buffer, res: ServerResponse): void {
  const forge = getForge();
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let pack = Buffer.alloc(0);
  try {
    const decoded = decodePackets(body, true);
    let first = true;
    for (const packet of decoded.packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8');
      const nul = first ? line.indexOf('\u0000') : -1;
      const commandText = nul >= 0 ? line.slice(0, nul) : line;
      if (nul >= 0) capabilities = line.slice(nul + 1).trim().split(/\s+/).filter(Boolean);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(commandText.trim());
      if (match === null) throw new Error('a receive-pack command line is malformed');
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      first = false;
    }
    pack = decoded.rest;
  } catch {
    const inner = Buffer.concat([pkt('unpack expected a valid command list\n'), FLUSH]);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), FLUSH]));
    return;
  }

  let unpackOk = true;
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => forge.getObject(key, oid));
      for (const [oid, object] of read.objects) {
        if (forge.getObject(key, oid) === undefined) forge.putObject(key, object.type, object.data);
      }
    } catch {
      unpackOk = false;
    }
  }

  const lines: Buffer[] = [];
  lines.push(pkt(unpackOk ? 'unpack ok\n' : 'unpack error\n'));
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(pkt(`ng ${command.ref} unpacker error\n`));
      continue;
    }
    if (command.newOid === ZERO_OID) {
      forge.deleteRefOid(key, command.ref);
      lines.push(pkt(`ok ${command.ref}\n`));
      continue;
    }
    if (forge.getObject(key, command.newOid) === undefined) {
      lines.push(pkt(`ng ${command.ref} missing necessary objects\n`));
      continue;
    }
    const current = forge.getRefOid(key, command.ref);
    if (current === undefined || current === ZERO_OID) {
      forge.setRefOid(key, command.ref, command.newOid);
      lines.push(pkt(`ok ${command.ref}\n`));
      continue;
    }
    if (current === command.newOid) {
      lines.push(pkt(`ok ${command.ref}\n`));
      continue;
    }
    const next = forge.getObject(key, command.newOid);
    const previous = forge.getObject(key, current);
    const fastForward =
      next !== undefined && previous !== undefined && next.type === 'commit' && previous.type === 'commit'
        ? forge.isAncestor(key, current, command.newOid)
        : false;
    if (!fastForward) {
      lines.push(pkt(`ng ${command.ref} non-fast-forward\n`));
      continue;
    }
    forge.setRefOid(key, command.ref, command.newOid);
    const repo = forge.getRepo(key.split('/')[0] as string, key.split('/').slice(1).join('/'));
    if (repo !== undefined) {
      repo.pushed_at = forge.now;
      repo.updated_at = forge.now;
    }
    lines.push(pkt(`ok ${command.ref}\n`));
  }
  lines.push(FLUSH);
  const report = Buffer.concat(lines);
  const sideband = capabilities.includes('side-band-64k');
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(sideband ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), FLUSH]) : report);
}

// ---------------------------------------------------------------- entry point

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function splitRepo(path: string): { owner: string; repo: string; action: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) return null;
  try {
    return {
      owner: decodeURIComponent(match[1] as string),
      repo: decodeURIComponent(match[2] as string),
      action: match[3] as string,
    };
  } catch {
    return null;
  }
}

/** Answer one smart-HTTP request; false when the path is not a git service route. */
export async function handleGitRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const target = splitRepo(url.pathname);
  if (target === null) return false;
  const forge = getForge();
  const repo = forge.getRepo(target.owner, target.repo);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"message":"Not Found"}');
    return true;
  }
  const key = forge.repoKey(target.owner, target.repo);

  if (target.action === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"message":"smart HTTP needs a service parameter"}');
      return true;
    }
    const header = req.headers['git-protocol'];
    const wantsV2 = service === 'git-upload-pack' && typeof header === 'string' && /(^|[,;\s])version=2([,;\s]|$)/.test(header);
    const body = wantsV2
      ? v2Advertisement()
      : Buffer.concat([serviceHeader(service), v0Advertisement(key, service)]);
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
    res.end(body);
    return true;
  }

  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"message":"Method Not Allowed"}');
    return true;
  }
  const body = await readBody(req);

  if (target.action === 'git-receive-pack') {
    receivePack(key, body, res);
    return true;
  }

  let packets: Packet[];
  try {
    packets = decodePackets(body).packets;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"message":"a git request body is not a pkt-line stream"}');
    return true;
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first === undefined ? '' : first.payload.toString('utf8');
  let answer: Buffer;
  if (command.startsWith('command=ls-refs')) answer = lsRefs(key, packets);
  else if (command.startsWith('command=fetch')) answer = fetchV2(key, packets);
  else answer = fetchV0(key, packets);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(answer);
  return true;
}
