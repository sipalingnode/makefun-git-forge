// The forge's data store: one deterministic in-memory state for the REST, GraphQL, MCP and
// smart-HTTP surfaces, plus the git object model (sha1 objects, trees, commits, tags) and the
// packfile codec the smart-HTTP server needs.
//
// Nothing here reads a clock or Math.random: every timestamp is the trial's own `now`
// (MAKEFUN_TRIAL_NOW), and every id is a counter in creation order. Two runs of the same trial
// therefore build the same store, field for field.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- types

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  has_issues: boolean;
  next_issue_number: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  head: string;
  head_sha: string;
  base: string;
  base_sha: string;
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

// ---------------------------------------------------------------- git objects

export function hashObject(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`, 'latin1');
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('latin1'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compared as bytes, a directory as its name plus '/'. */
function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const header = data.subarray(0, headerEnd).toString('utf8');
  const view: CommitView = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5);
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7));
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: TagView = { object: '', type: 'commit', tag: '', tagger: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7);
    else if (line.startsWith('type ')) view.type = line.slice(5) as ObjType;
    else if (line.startsWith('tag ')) view.tag = line.slice(4);
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

export interface CommitIdentity {
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
}

export function buildCommit(fields: { tree: string; parents?: string[]; message: string; identity: CommitIdentity }): Buffer {
  const timezone = fields.identity.timezone ?? '+0000';
  const author = `${fields.identity.author} ${fields.identity.timestamp} ${timezone}`;
  const committer = `${fields.identity.committer ?? fields.identity.author} ${fields.identity.timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- packfiles

export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** Inflate one zlib stream from `buffer`, answering the data and how many input bytes it used. */
function inflateOne(buffer: Buffer): { data: Buffer; used: number } {
  const result = inflateSync(buffer, { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: number } };
  const used = result.engine?.bytesWritten;
  if (typeof used === 'number' && used > 0 && used <= buffer.length) return { data: result.buffer, used };
  // Fallback (a runtime without engine.bytesWritten): the shortest prefix that inflates. Inflating a
  // longer prefix succeeds too (zlib stops at the stream's end), so "succeeds" is monotonic and a
  // binary search finds the stream's exact length.
  const tries = (length: number): boolean => {
    try {
      inflateSync(buffer.subarray(0, length));
      return true;
    } catch {
      return false;
    }
  };
  let high = 2;
  while (high < buffer.length && !tries(high)) high = Math.min(buffer.length, high * 2);
  if (!tries(high)) throw new Error('a pack entry is not a complete zlib stream');
  let low = Math.max(2, Math.floor(high / 2) + 1);
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tries(middle)) high = middle;
    else low = middle + 1;
  }
  return { data: inflateSync(buffer.subarray(0, high)), used: high };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta names a ${baseSize}-byte base, got ${base.length}`);
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let written = 0;
  while (offset < delta.length) {
    const command = delta[offset++];
    if (command === 0) throw new Error('delta instruction 0 is reserved');
    if (command & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (command & 0x01) copyOffset |= delta[offset++];
      if (command & 0x02) copyOffset |= delta[offset++] << 8;
      if (command & 0x04) copyOffset |= delta[offset++] << 16;
      if (command & 0x08) copyOffset |= delta[offset++] << 24;
      if (command & 0x10) copySize |= delta[offset++];
      if (command & 0x20) copySize |= delta[offset++] << 8;
      if (command & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past its base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else {
      if (offset + command > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + command);
      offset += command;
      written += command;
    }
  }
  if (written !== resultSize) throw new Error(`delta produced ${written} bytes, expected ${resultSize}`);
  return out;
}

export interface PackRead {
  version: number;
  objects: Map<string, GitObj>;
  deltaCount: number;
}

/** Read a packfile, resolving OFS/REF deltas (a thin pack's bases come from `resolveBase`). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): PackRead {
  if (pack.length < 32) throw new Error('pack is too small');
  if (pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObj>();
  const byOffset = new Map<number, GitObj>();
  let offset = 12;
  let deltaCount = 0;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    if (offset >= pack.length) throw new Error('pack is truncated at an entry header');
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= pack.length) throw new Error('pack entry size is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 56) throw new Error('pack entry size is too long');
    }
    let ofsBase: GitObj | undefined;
    let refBaseOid = '';
    if (typeCode === 6) {
      let c = pack[offset++];
      let distance = c & 0x7f;
      while (c & 0x80) {
        c = pack[offset++];
        distance = ((distance + 1) << 7) | (c & 0x7f);
      }
      ofsBase = byOffset.get(start - distance);
      if (ofsBase === undefined) throw new Error('ofs-delta names an unknown base offset');
    } else if (typeCode === 7) {
      if (offset + 20 > pack.length) throw new Error('ref-delta base is truncated');
      refBaseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    if (offset >= pack.length) throw new Error('pack entry has no data');
    const inflated = inflateOne(pack.subarray(offset));
    offset += inflated.used;
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      const base = typeCode === 6 ? ofsBase : resolveBase?.(refBaseOid) ?? objects.get(refBaseOid);
      if (base === undefined) throw new Error(`delta base ${refBaseOid || '(ofs)'} is missing`);
      type = base.type;
      data = applyDelta(base.data, inflated.data);
    } else if (typeCode === 1 || typeCode === 2 || typeCode === 3 || typeCode === 4) {
      type = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : 'tag';
      data = inflated.data;
    } else {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    if (data.length !== size) throw new Error(`pack entry declares ${size} bytes, inflated ${data.length}`);
    const object: GitObj = { type, data };
    objects.set(hashObject(type, data), object);
    byOffset.set(start, object);
  }
  if (offset + 20 > pack.length) throw new Error('pack has no trailer');
  return { version, objects, deltaCount };
}

/** Write a pack (no deltas) with a level-1 deflate, fast enough for the benchmark's clones. */
export function writePack(objects: GitObj[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const typeCode = object.type === 'commit' ? 1 : object.type === 'tree' ? 2 : object.type === 'blob' ? 3 : 4;
    let size = object.data.length;
    const head: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>>= 4;
    while (size > 0) {
      head.push(first | 0x80);
      first = size & 0x7f;
      size >>>= 7;
    }
    head.push(first);
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data, { level: 0 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- the forge

export interface DiffEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

const TREE_MODE = '40000';
const FILE_MODE = '100644';

export class Forge {
  readonly now: string;
  readonly viewer: User;
  private readonly repos = new Map<string, Repo>();
  private readonly objects = new Map<string, Map<string, GitObj>>();
  private readonly refs = new Map<string, Map<string, string>>();
  private readonly issues = new Map<string, Map<number, Issue>>();
  private readonly labels = new Map<string, Map<string, Label>>();
  private readonly comments = new Map<string, Map<number, Comment>>();
  private readonly prs = new Map<string, Map<number, PullRequest>>();
  private repoSeq = 0;
  private issueSeq = 0;
  private labelSeq = 0;
  private commentSeq = 0;
  private prSeq = 0;

  constructor(now: string, viewer: User) {
    this.now = now;
    this.viewer = viewer;
  }

  // ---------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  allRepos(): Repo[] {
    return [...this.repos.values()];
  }

  createRepo(name: string, description: string | null, private_: boolean): Repo {
    const key = this.repoKey(this.viewer.login, name);
    const existing = this.repos.get(key);
    if (existing !== undefined) throw new Error('Repository already exists');
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      full_name: key,
      owner: this.viewer.login,
      description,
      private: private_,
      default_branch: 'main',
      created_at: this.now,
      updated_at: this.now,
      pushed_at: null,
      has_issues: true,
      next_issue_number: 0,
    };
    this.repos.set(key, repo);
    this.objects.set(key, new Map());
    this.refs.set(key, new Map());
    this.issues.set(key, new Map());
    this.labels.set(key, new Map());
    this.comments.set(key, new Map());
    this.prs.set(key, new Map());
    return repo;
  }

  /** Rename a repository, moving every map that is keyed by its full name. */
  renameRepo(oldName: string, newName: string): Repo | undefined {
    const oldKey = this.repoKey(this.viewer.login, oldName);
    const newKey = this.repoKey(this.viewer.login, newName);
    const repo = this.repos.get(oldKey);
    if (repo === undefined) return undefined;
    if (this.repos.has(newKey)) throw new Error('Repository already exists');
    repo.name = newName;
    repo.full_name = newKey;
    repo.updated_at = this.now;
    this.repos.delete(oldKey);
    this.repos.set(newKey, repo);
    const move = <T>(map: Map<string, T>): void => {
      const value = map.get(oldKey);
      if (value === undefined) return;
      map.delete(oldKey);
      map.set(newKey, value);
    };
    move(this.objects);
    move(this.refs);
    move(this.issues);
    move(this.labels);
    move(this.comments);
    move(this.prs);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    if (!this.repos.delete(key)) return false;
    this.objects.delete(key);
    this.refs.delete(key);
    this.issues.delete(key);
    this.labels.delete(key);
    this.comments.delete(key);
    this.prs.delete(key);
    return true;
  }

  touch(repo: Repo): void {
    repo.updated_at = this.now;
  }

  // ---------------------------------------------------------------- git objects

  private objectsOf(key: string): Map<string, GitObj> {
    let map = this.objects.get(key);
    if (map === undefined) {
      map = new Map();
      this.objects.set(key, map);
    }
    return map;
  }

  putObject(key: string, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    const map = this.objectsOf(key);
    if (!map.has(oid)) map.set(oid, { type, data });
    return oid;
  }

  getObject(key: string, oid: string): GitObj | undefined {
    return this.objectsOf(key).get(oid);
  }

  // ---------------------------------------------------------------- refs

  private refsOf(key: string): Map<string, string> {
    let map = this.refs.get(key);
    if (map === undefined) {
      map = new Map();
      this.refs.set(key, map);
    }
    return map;
  }

  getRefOid(key: string, ref: string): string | undefined {
    return this.refsOf(key).get(ref);
  }

  setRefOid(key: string, ref: string, oid: string): void {
    this.refsOf(key).set(ref, oid);
  }

  deleteRefOid(key: string, ref: string): boolean {
    return this.refsOf(key).delete(ref);
  }

  branches(key: string): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [ref, oid] of this.refsOf(key)) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), oid });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  tags(key: string): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [ref, oid] of this.refsOf(key)) {
      if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice('refs/tags/'.length), oid });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The refs a client may fetch: heads first, then tags. */
  refList(key: string): Array<{ ref: string; oid: string }> {
    const out: Array<{ ref: string; oid: string }> = [];
    for (const [ref, oid] of this.refsOf(key)) out.push({ ref, oid });
    return out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  headOid(key: string): string | undefined {
    const repo = this.repos.get(key);
    if (repo === undefined) return undefined;
    return this.refsOf(key).get(`refs/heads/${repo.default_branch}`);
  }

  // ---------------------------------------------------------------- reachability

  /** Every object reachable from `roots` (commits, trees, blobs, tags): for packs and intervals. */
  closure(key: string, roots: Iterable<string>, limits?: { skip?: Set<string> }): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid) || limits?.skip?.has(oid)) continue;
      const object = this.getObject(key, oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  isAncestor(key: string, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.getObject(key, oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  peekOid(key: string, oid: string): ObjType | null {
    const object = this.getObject(key, oid);
    return object === undefined ? null : object.type;
  }

  // ---------------------------------------------------------------- commits and trees

  commitChain(key: string, start: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.getObject(key, oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Flatten a commit's tree into path -> entry (files only; a gitlink is skipped). */
  flatTree(key: string, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    if (commitOid === undefined) return files;
    const commit = this.getObject(key, commitOid);
    if (commit === undefined || commit.type !== 'commit') return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.getObject(key, treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === TREE_MODE) walk(entry.oid, path);
        else if (entry.mode !== '160000') files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return files;
  }

  fileContent(key: string, path: string, commitOid: string | undefined): Buffer | null {
    const file = this.flatTree(key, commitOid).get(path);
    if (file === undefined) return null;
    const blob = this.getObject(key, file.oid);
    return blob === undefined ? null : blob.data;
  }

  /** Build a tree holding `files` (path -> blob oid/mode); nested directories are built as needed. */
  buildTreeFrom(key: string, files: Map<string, { oid: string; mode: string }>): string {
    const dirs = new Map<string, TreeEntry[]>();
    const root: TreeEntry[] = [];
    const ensure = (dir: string): TreeEntry[] => {
      let list = dirs.get(dir);
      if (list === undefined) {
        list = [];
        dirs.set(dir, list);
      }
      return list;
    };
    ensure('');
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let parent = '';
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        const list = ensure(parent);
        const childPath = parent === '' ? name : `${parent}/${name}`;
        if (!list.some((candidate) => candidate.name === name)) list.push({ mode: TREE_MODE, name, oid: '' });
        ensure(childPath);
        parent = childPath;
      }
      ensure(parent).push({ mode: entry.mode, name: segments[segments.length - 1], oid: entry.oid });
    }
    // Materialise bottom-up: deeper directories first.
    const dirNames = [...dirs.keys()].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1));
    for (const dir of dirNames) {
      const list = dirs.get(dir) as TreeEntry[];
      for (const entry of list) {
        if (entry.mode === TREE_MODE && entry.oid === '') {
          const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
          const childEntries = dirs.get(child) ?? [];
          entry.oid = this.putObject(key, 'tree', buildTree(childEntries));
        }
      }
      if (dir === '') return this.putObject(key, 'tree', buildTree(list));
    }
    return this.putObject(key, 'tree', Buffer.alloc(0));
  }

  private commitIdentity(): CommitIdentity {
    const seconds = Math.floor(Date.parse(this.now) / 1000);
    const stamp = Number.isFinite(seconds) ? seconds : 1700000000;
    return { author: `${this.viewer.name} <${this.viewer.email}>`, timestamp: stamp };
  }

  /** Create a commit on `branch` with `files` (a full flat tree), parented on the branch tip. */
  commitTree(key: string, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
    const ref = `refs/heads/${branch}`;
    const parent = this.getRefOid(key, ref);
    const tree = this.buildTreeFrom(key, files);
    const data = buildCommit({ tree, parents: parent === undefined ? [] : [parent], message, identity: this.commitIdentity() });
    const oid = this.putObject(key, 'commit', data);
    this.setRefOid(key, ref, oid);
    const repo = this.repos.get(key);
    if (repo !== undefined) {
      repo.pushed_at = this.now;
      repo.updated_at = this.now;
    }
    return oid;
  }

  /** Write one file (base64 or raw bytes) on `branch`, answering the new commit and blob ids. */
  writeFile(key: string, branch: string, path: string, content: Buffer, message: string, expectedSha?: string | null): { commit: string; blob: string } | 'stale' {
    const tip = this.getRefOid(key, `refs/heads/${branch}`);
    const files = this.flatTree(key, tip);
    const current = files.get(path);
    if (expectedSha !== undefined && expectedSha !== null && expectedSha !== '') {
      if (current === undefined || current.oid !== expectedSha) return 'stale';
    }
    const blob = this.putObject(key, 'blob', content);
    files.set(path, { oid: blob, mode: current?.mode ?? FILE_MODE });
    const commit = this.commitTree(key, branch, files, message);
    return { commit, blob };
  }

  deleteFile(key: string, branch: string, path: string, message: string): { commit: string; removed: boolean } {
    const tip = this.getRefOid(key, `refs/heads/${branch}`);
    const files = this.flatTree(key, tip);
    const removed = files.delete(path);
    const commit = this.commitTree(key, branch, files, message);
    return { commit, removed };
  }

  // ---------------------------------------------------------------- issues

  private issuesOf(key: string): Map<number, Issue> {
    let map = this.issues.get(key);
    if (map === undefined) {
      map = new Map();
      this.issues.set(key, map);
    }
    return map;
  }

  createIssue(key: string, title: string, body: string | null, labelNames: string[]): Issue {
    const repo = this.repos.get(key);
    if (repo === undefined) throw new Error('no such repository');
    repo.next_issue_number += 1;
    this.issueSeq += 1;
    const issue: Issue = {
      id: this.issueSeq,
      number: repo.next_issue_number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      user: this.viewer,
      created_at: this.now,
      updated_at: this.now,
      closed_at: null,
      comments: 0,
    };
    this.issuesOf(key).set(issue.number, issue);
    return issue;
  }

  getIssue(key: string, number: number): Issue | undefined {
    return this.issuesOf(key).get(number);
  }

  listIssues(key: string): Issue[] {
    return [...this.issuesOf(key).values()];
  }

  // ---------------------------------------------------------------- labels

  private labelsOf(key: string): Map<string, Label> {
    let map = this.labels.get(key);
    if (map === undefined) {
      map = new Map();
      this.labels.set(key, map);
    }
    return map;
  }

  createLabel(key: string, name: string, color: string, description: string | null): Label {
    this.labelSeq += 1;
    const label: Label = { id: this.labelSeq, name, color, description };
    this.labelsOf(key).set(name, label);
    return label;
  }

  getLabel(key: string, name: string): Label | undefined {
    return this.labelsOf(key).get(name);
  }

  listLabels(key: string): Label[] {
    return [...this.labelsOf(key).values()];
  }

  // ---------------------------------------------------------------- comments

  private commentsOf(key: string): Map<number, Comment> {
    let map = this.comments.get(key);
    if (map === undefined) {
      map = new Map();
      this.comments.set(key, map);
    }
    return map;
  }

  createComment(key: string, body: string): Comment {
    this.commentSeq += 1;
    const comment: Comment = { id: this.commentSeq, body, user: this.viewer, created_at: this.now, updated_at: this.now };
    this.commentsOf(key).set(comment.id, comment);
    return comment;
  }

  listComments(key: string): Comment[] {
    return [...this.commentsOf(key).values()];
  }

  // ---------------------------------------------------------------- pull requests

  private prsOf(key: string): Map<number, PullRequest> {
    let map = this.prs.get(key);
    if (map === undefined) {
      map = new Map();
      this.prs.set(key, map);
    }
    return map;
  }

  createPullRequest(key: string, title: string, body: string | null, head: string, base: string): PullRequest {
    const headSha = this.getRefOid(key, `refs/heads/${head}`) ?? '';
    const baseSha = this.getRefOid(key, `refs/heads/${base}`) ?? '';
    this.prSeq += 1;
    const pr: PullRequest = {
      id: this.prSeq,
      number: this.prSeq,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
      head,
      head_sha: headSha,
      base,
      base_sha: baseSha,
      user: this.viewer,
      created_at: this.now,
      updated_at: this.now,
      closed_at: null,
    };
    this.prsOf(key).set(pr.number, pr);
    return pr;
  }

  getPull(key: string, number: number): PullRequest | undefined {
    return this.prsOf(key).get(number);
  }

  listPulls(key: string): PullRequest[] {
    return [...this.prsOf(key).values()];
  }

  /** The merge base of two commits: the nearest common ancestor, or null. */
  mergeBase(key: string, left: string, right: string): string | null {
    const ancestors = new Set<string>();
    const queue = [left];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = this.getObject(key, oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const seen = new Set<string>();
    const walk = [right];
    while (walk.length > 0) {
      const oid = walk.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = this.getObject(key, oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) walk.push(parent);
    }
    return null;
  }

  diff(key: string, baseOid: string | undefined, headOid: string | undefined): DiffEntry[] {
    const baseFiles = this.flatTree(key, baseOid);
    const headFiles = this.flatTree(key, headOid);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const out: DiffEntry[] = [];
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
      const beforeData = before === undefined ? null : this.getObject(key, before.oid)?.data ?? null;
      const afterData = after === undefined ? null : this.getObject(key, after.oid)?.data ?? null;
      const beforeLines = beforeData === null ? 0 : countLines(beforeData);
      const afterLines = afterData === null ? 0 : countLines(afterData);
      const status: DiffEntry['status'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
      out.push({
        filename: path,
        status,
        additions: status === 'removed' ? 0 : Math.max(1, afterLines),
        deletions: status === 'added' ? 0 : Math.max(0, beforeLines),
        changes: Math.max(1, afterLines + beforeLines),
        sha: after?.oid ?? before?.oid ?? '',
      });
    }
    return out;
  }

  /** Whether squashing `head` onto `base` would conflict (both sides changed one path from their merge base). */
  conflicts(key: string, head: string, base: string): boolean {
    const baseCommit = this.mergeBase(key, head, base);
    if (baseCommit === null) return true;
    const baseFiles = this.flatTree(key, baseCommit);
    const headFiles = this.flatTree(key, head);
    const targetFiles = this.flatTree(key, base);
    for (const [path, entry] of headFiles) {
      const original = baseFiles.get(path);
      const target = targetFiles.get(path);
      if (target === undefined || original === undefined) continue;
      if (entry.oid !== original.oid && target.oid !== original.oid && entry.oid !== target.oid) return true;
    }
    return false;
  }

  /** Squash-merge: a new commit on `base` holding the head's tree. */
  merge(key: string, pr: PullRequest, method: string): string | null {
    const headTip = this.getRefOid(key, `refs/heads/${pr.head}`);
    const baseTip = this.getRefOid(key, `refs/heads/${pr.base}`);
    if (headTip === undefined) return null;
    if (this.conflicts(key, headTip, baseTip ?? '')) return null;
    const files = this.flatTree(key, headTip);
    const tree = this.buildTreeFrom(key, files);
    const message = method === 'merge'
      ? `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`
      : `${pr.title} (#${pr.number})\n\n${pr.body ?? ''}`;
    const data = buildCommit({ tree, parents: baseTip === undefined ? [] : [baseTip], message, identity: this.commitIdentity() });
    const oid = this.putObject(key, 'commit', data);
    this.setRefOid(key, `refs/heads/${pr.base}`, oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = this.now;
    pr.closed_at = this.now;
    pr.updated_at = this.now;
    pr.merge_commit_sha = oid;
    pr.base_sha = oid;
    return oid;
  }
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 1;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines - 1 : lines;
}

// ---------------------------------------------------------------- factory

let forgeInstance: Forge | null = null;

export function createForge(now: string): Forge {
  forgeInstance = new Forge(now, {
    id: 1000,
    login: 'adaiversen',
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  });
  return forgeInstance;
}

export function getForge(): Forge {
  if (forgeInstance === null) throw new Error('the forge store was not created');
  return forgeInstance;
}
