// gitproto.ts — the git wire formats this forge speaks, implemented from scratch on
// node:crypto and node:zlib: pkt-line framing, the object model (SHA-1 ids, commit /
// tree / tag parsing and building), packfile reading (with OFS/REF delta resolution)
// and writing (plain objects only), and the object selection a fetch answers with.
//
// Everything here is pure bytes-in / bytes-out: no HTTP, no store. The store hands this
// module a lookup function and gets back the objects a fetch must send.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload of ${data.length} bytes exceeds the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Encode a sequence; 'flush' / 'delim' items are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the head of `bytes`. Stops at the first byte sequence that is not a
 * pkt-line header and returns the rest as `remainder` (a receive-pack body carries its pack
 * unframed after the command flush, and a fetch body ends at its final flush).
 */
export function decodePktLines(bytes: Uint8Array): { packets: Packet[]; remainder: Buffer } {
  const buffer = asBuffer(bytes);
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, remainder: buffer.subarray(offset) };
}

/** The text of every data packet, in order. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// -------------------------------------------------------------------------------------------
// object model
// -------------------------------------------------------------------------------------------

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  return createHash('sha1').update(Buffer.from(`${type} ${body.length}\0`, 'utf8')).update(body).digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(compareTreeEntries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. Unknown headers are ignored: traversal only needs tree/parents. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerText = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel tags until a non-tag object: the commit a ref ultimately names. Returns null when the chain breaks. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    try {
      current = parseTag(object.data).object;
    } catch {
      return null;
    }
  }
  return null;
}

/** Peel one tag layer: the object a tag names, or the oid itself when it is not a tag. */
export function peelOnce(oid: string, lookup: ObjectLookup): string {
  const object = lookup(oid);
  if (!object || object.type !== 'tag') return oid;
  try {
    return parseTag(object.data).object;
  } catch {
    return oid;
  }
}

/** Every object reachable from `roots` (commits, trees, blobs, tags; gitlinks skipped). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    try {
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
    } catch {
      // A corrupt object stops this branch of the walk; the store never holds one.
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` by following parents (or is the tip itself). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } catch {
      // Corrupt commit: no further parents.
    }
  }
  return false;
}

/**
 * The merge base of two commits: the first commit reachable from `head` that is also reachable
 * from `base`, walking breadth-first from the head. Linear histories (and the suite's forks)
 * have exactly one such commit, and breadth-first order finds it.
 */
export function mergeBase(head: string, base: string, lookup: ObjectLookup): string | null {
  const baseAncestors = new Set<string>();
  const baseQueue = [base];
  while (baseQueue.length > 0) {
    const oid = baseQueue.pop()!;
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) baseQueue.push(parent);
    } catch {
      // Corrupt commit: no further parents.
    }
  }
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (baseAncestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } catch {
      // Corrupt commit: no further parents.
    }
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// packfile reading (with delta resolution) and writing (plain objects)
// -------------------------------------------------------------------------------------------

function readPackEntryHeader(buffer: Buffer, start: number): { size: number; typeCode: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry has no header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, typeCode: (first >> 4) & 0x07, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta's copy/insert instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly declaredCount: number;
  readonly checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA and REF_DELTA entries. A REF_DELTA base
 * the pack does not hold is looked up through `resolveBase` (a thin pack's already-held base).
 * Every object's SHA-1 is recomputed; the trailer checksum is reported, not enforced, by this
 * function — the caller decides what a bad trailer means.
 */
export function readPack(pack: Uint8Array, resolveBase?: ObjectLookup): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(buffer, offset);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry inflated size does not match its header');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor held`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, declaredCount, checksumOk: trailer === computedTrailer };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas): the order is the caller's, the trailer is
 * SHA-1 over everything before it. Level-1 compression: pack bytes stay valid at any level, and
 * the fetch workloads are latency-bound.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------

export interface FetchSelection {
  /** The objects to send, in walk order. */
  readonly objects: GitObject[];
  /** The new shallow boundary commits (depth cutoffs that stay shallow). */
  readonly shallow: string[];
  /** Formerly-shallow commits whose parents are now all included. */
  readonly unshallow: string[];
  /** The first have that is an ancestor of (or equal to) a want, when one exists. */
  readonly ack: string | null;
}

/**
 * The objects a fetch answers with.
 *
 * `wants` are the tips the client asked for; `haves` are commits it already holds whole
 * (their full closure is never re-sent); `shallows` are its current shallow boundaries
 * (held commits whose trees it holds but whose parents it does not); `depth` caps the
 * commit distance from the wants, counting the wants themselves as distance 0.
 *
 * Rules, each pinned by the protocol: a have's closure is excluded outright; a shallow
 * boundary is never re-sent, and without a depth it also cuts the walk; with a depth the
 * walk passes through boundaries up to the depth, the commits at distance depth-1 become
 * the new boundary, and a boundary whose parents all arrive is unshallowed.
 */
/**
 * What the client's `have` lines prove it holds. A shallow boundary cuts the walk: the
 * client holds the boundary commit and its tree, but NOT its parents — a deepen fetch
 * must deliver them. Without this cut, `have=tip` + `shallow=tip` + `deepen 2` would
 * wrongly conclude the parent is already held and send nothing.
 */
function collectHeld(
  haves: readonly string[],
  lookup: ObjectLookup,
  shallowSet: ReadonlySet<string>,
): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    try {
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        const treeQueue = [commit.tree];
        while (treeQueue.length > 0) {
          const treeOid = treeQueue.pop()!;
          if (held.has(treeOid)) continue;
          const treeObject = lookup(treeOid);
          if (!treeObject || treeObject.type !== 'tree') continue;
          held.add(treeOid);
          for (const entry of parseTree(treeObject.data)) {
            if (entry.mode === '40000') treeQueue.push(entry.oid);
            else if (entry.mode !== '160000') held.add(entry.oid);
          }
        }
        if (!shallowSet.has(oid)) queue.push(...commit.parents);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '40000') queue.push(entry.oid);
          else if (entry.mode !== '160000') held.add(entry.oid);
        }
      }
    } catch {
      // Corrupt object: the object itself is held, its links are not.
    }
  }
  return held;
}

export function selectFetchObjects(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  shallows: readonly string[],
  depth: number | null,
): FetchSelection {
  const shallowSet = new Set(shallows.filter(isObjectId));
  const haveClosure = collectHeld(haves, lookup, shallowSet);
  // What the client already holds through its shallow boundaries: the boundary commits and
  // their trees, but not their parents.
  const shallowHeld = new Set<string>();
  for (const boundary of shallowSet) {
    const object = lookup(boundary);
    if (!object) continue;
    shallowHeld.add(boundary);
    if (object.type === 'commit') {
      try {
        const commit = parseCommit(object.data);
        const treeQueue = [commit.tree];
        while (treeQueue.length > 0) {
          const treeOid = treeQueue.pop()!;
          if (shallowHeld.has(treeOid)) continue;
          const treeObject = lookup(treeOid);
          if (!treeObject || treeObject.type !== 'tree') continue;
          shallowHeld.add(treeOid);
          try {
            for (const entry of parseTree(treeObject.data)) {
              if (entry.mode === '40000') treeQueue.push(entry.oid);
              else if (entry.mode !== '160000') shallowHeld.add(entry.oid);
            }
          } catch {
            // Corrupt tree: stop this branch.
          }
        }
      } catch {
        // Corrupt commit: only the commit itself is held.
      }
    }
  }
  const excluded = new Set<string>([...haveClosure, ...shallowHeld]);

  // Resolve wants: tags peel to their targets, which join the walk as roots.
  const roots: string[] = [];
  const extraObjects = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      extraObjects.add(want);
      let target = want;
      for (let hops = 0; hops < 32; hops += 1) {
        const current = lookup(target);
        if (!current || current.type !== 'tag') break;
        try {
          target = parseTag(current.data).object;
        } catch {
          break;
        }
        if (lookup(target)?.type === 'tag') extraObjects.add(target);
      }
      roots.push(target);
    } else {
      roots.push(want);
    }
  }

  // Breadth-first over the commit graph from the roots, honouring the depth cap.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!distance.has(root)) {
      distance.set(root, 0);
      queue.push(root);
    }
  }
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const dist = distance.get(oid)!;
    // A held commit's parents are held too — unless it is a shallow boundary, whose
    // parents the client does NOT hold. With a depth cap the walk must pass a held
    // boundary to reach the generations a deepen asks for.
    if (haveClosure.has(oid) && !shallowSet.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    if (object.type !== 'commit') {
      extraObjects.add(oid);
      continue;
    }
    if (depth === null && shallowSet.has(oid)) continue; // a boundary cuts the walk
    if (depth !== null && dist > depth - 1) continue;
    if (!shallowSet.has(oid)) includedCommits.add(oid);
    if (depth !== null && dist === depth - 1) {
      boundary.add(oid);
      continue;
    }
    try {
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push(parent);
        }
      }
    } catch {
      // Corrupt commit: no parents to walk.
    }
  }

  // The objects to send: the included commits and each one's own tree closure (trees and
  // blobs only — never crossing into another commit, or a depth cap would leak ancestors'
  // trees), plus any tag / non-commit roots, minus everything the client already holds.
  const treeClosure = (treeOid: string, into: Map<string, GitObject>): void => {
    const queue = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (excluded.has(oid) || into.has(oid)) continue;
      const object = lookup(oid);
      if (!object || (object.type !== 'tree' && object.type !== 'blob')) continue;
      into.set(oid, object);
      if (object.type === 'tree') {
        try {
          for (const entry of parseTree(object.data)) {
            if (entry.mode !== '160000') queue.push(entry.oid);
          }
        } catch {
          // Corrupt tree: stop this branch.
        }
      }
    }
  };
  const send = new Map<string, GitObject>();
  for (const oid of includedCommits) {
    const object = lookup(oid);
    if (!object || excluded.has(oid)) continue;
    send.set(oid, object);
    try {
      treeClosure(parseCommit(object.data).tree, send);
    } catch {
      // Corrupt commit: its tree stays out.
    }
  }
  for (const oid of extraObjects) {
    if (excluded.has(oid) || send.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    send.set(oid, object);
    if (object.type === 'tag') {
      const target = peelOnce(oid, lookup);
      if (target !== oid && !excluded.has(target)) {
        const targetObject = lookup(target);
        if (targetObject) {
          if (targetObject.type === 'commit' && includedCommits.has(target)) {
            // Already sent above with its tree.
          } else if (targetObject.type === 'tree') {
            treeClosure(target, send);
          } else if (targetObject.type === 'blob') {
            send.set(target, targetObject);
          }
        }
      }
    } else if (object.type === 'tree') {
      treeClosure(oid, send);
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) shallow.push(oid);
    for (const oid of shallowSet) {
      if (boundary.has(oid)) continue;
      if (!distance.has(oid)) continue; // unrelated boundary: untouched
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      let satisfied = true;
      try {
        for (const parent of parseCommit(object.data).parents) {
          if (!includedCommits.has(parent) && !haveClosure.has(parent) && !shallowSet.has(parent)) {
            satisfied = false;
            break;
          }
        }
      } catch {
        satisfied = false;
      }
      if (satisfied) unshallow.push(oid);
    }
  }

  let ack: string | null = null;
  if (haves.length > 0) {
    const wantClosure = collectReachable(roots, lookup);
    for (const have of haves) {
      if (wantClosure.has(have)) {
        ack = have;
        break;
      }
    }
  }

  return { objects: [...send.values()], shallow, unshallow, ack };
}
