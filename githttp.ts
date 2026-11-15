// githttp.ts — git smart HTTP: info/refs advertisements (protocol v2 for upload-pack,
// v0 for receive-pack), the v2 ls-refs and fetch commands, the v0 fetch fallback, and the
// v0 receive-pack push path with report-status over side-band-64k.
//
// The framing rules this file honours: a v2 advertisement opens with `version 2` and lists
// capabilities; a v0 advertisement opens with the `# service=` preamble and lists refs with
// capabilities after a NUL on the first line; a fetch answer is sections (acknowledgments,
// shallow-info, packfile) separated by flush packets, the pack travelling in band-1
// sideband packets; a push answer is a report-status stream inside band 1.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  packetLines,
  peelToCommit,
  readPack,
  selectFetchObjects,
  writePack,
  type Packet,
} from './gitproto.ts';
import { VIEWER_LOGIN, type ForgeStore, type RepoRecord } from './store.ts';
import { messageReply, type Ctx, type Reply } from './types.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k multi_ack_detailed thin-pack ofs-delta shallow';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main';

/** The v2 advertisement never varies: capabilities only, no refs. Build it once. */
const V2_ADVERTISEMENT: Buffer = encodePktLines([
  'version 2\n',
  'object-format=sha1\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'flush',
]);

/**
 * Memoised git wire responses. The keys are fingerprints of exactly the state each response
 * depends on, so a stale entry is impossible: objects are content-addressed and only ever
 * added, so `objects.size` pins the object set, and the refs fingerprint pins the ref set.
 * The map is capped; when it fills it is cleared rather than grown without bound.
 */
const GIT_CACHE_MAX = 128;

function cachedBody(repo: RepoRecord, key: string, build: () => Buffer): Buffer {
  const hit = repo.gitCache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  if (repo.gitCache.size >= GIT_CACHE_MAX) repo.gitCache.clear();
  repo.gitCache.set(key, built);
  return built;
}

function refsFingerprint(store: ForgeStore, repo: RepoRecord): string {
  return store
    .sortedRefs(repo)
    .map((ref) => `${ref.name}=${ref.oid}`)
    .join(',');
}

function stripLine(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/, '') : line;
}

/** Split sideband data into band-1 pkt-lines of at most 65515 payload bytes each. */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    out.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(encodePktLine(Buffer.from([band])));
  return out;
}

export function handleGit(ctx: Ctx, owner: string, repoName: string, subpath: string): Reply {
  try {
    const repo = owner === VIEWER_LOGIN ? ctx.store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) return messageReply(404, 'Not Found');
    if (ctx.method === 'GET' && subpath === '/info/refs') return handleInfoRefs(ctx, repo);
    if (ctx.method === 'POST' && subpath === '/git-upload-pack') return handleUploadPack(ctx, repo);
    if (ctx.method === 'POST' && subpath === '/git-receive-pack') return handleReceivePack(ctx, repo);
    return messageReply(404, 'Not Found');
  } catch {
    return messageReply(400, 'Bad Request');
  }
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

function v0Advertisement(store: ForgeStore, repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const flush = Buffer.from('0000', 'ascii');
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), flush];
  const refs = store.sortedRefs(repo);
  const mainTip = store.refTip(repo, 'refs/heads/main');
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag' && ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(ref.oid, store.lookup(repo));
        if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleInfoRefs(ctx: Ctx, repo: RepoRecord): Reply {
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return messageReply(404, 'Not Found');
  }
  const wantsV2 = service === 'git-upload-pack' && (ctx.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    return {
      status: 200,
      headers: { 'content-type': UPLOAD_ADVERTISEMENT },
      body: v2Advertisement(),
    };
  }
  return {
    status: 200,
    headers: { 'content-type': service === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT : RECEIVE_ADVERTISEMENT },
    body: cachedBody(repo, `adv0|${service}|${refsFingerprint(ctx.store, repo)}`, () =>
      v0Advertisement(ctx.store, repo, service),
    ),
  };
}

// -------------------------------------------------------------------------------------------
// upload-pack: v2 commands and the v0 fallback
// -------------------------------------------------------------------------------------------

function handleUploadPack(ctx: Ctx, repo: RepoRecord): Reply {
  const { packets } = decodePktLines(ctx.body);
  const lines = packetLines(packets);
  const first = lines.length > 0 ? stripLine(lines[0]!) : '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    // Arguments follow the delim packet; capability lines before it are ignored.
    const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimAt >= 0 ? packets.slice(delimAt + 1) : packets.slice(1);
    const args = packetLines(argPackets).map(stripLine).filter((line) => line !== '');
    if (command === 'ls-refs') return v2LsRefs(ctx, repo, args);
    if (command === 'fetch') return v2Fetch(ctx, repo, args);
    return {
      status: 200,
      headers: { 'content-type': UPLOAD_RESULT },
      body: encodePktLines([`ERR unknown command ${command}\n`, 'flush']),
    };
  }
  return v0Fetch(ctx, repo, packets);
}

function v2LsRefs(ctx: Ctx, repo: RepoRecord, args: readonly string[]): Reply {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix:')) prefixes.push(arg.slice('ref-prefix:'.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const refs = ctx.store.sortedRefs(repo);
  const mainTip = ctx.store.refTip(repo, 'refs/heads/main');
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) out.push('unborn HEAD symref-target:refs/heads/main\n');
  } else {
    if (symrefs && mainTip !== undefined && keep('HEAD')) {
      out.push(`${mainTip} HEAD symref-target:refs/heads/main\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = repo.objects.get(ref.oid);
        if (object && object.type === 'tag') {
          const peeled = peelToCommit(ref.oid, ctx.store.lookup(repo));
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      out.push(`${line}\n`);
    }
  }
  return {
    status: 200,
    headers: { 'content-type': UPLOAD_RESULT },
    body: encodePktLines([...out, 'flush']),
  };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n >= 0) depth = n;
    }
    // deepen-since / deepen-not / filter / thin-pack / no-progress / ofs-delta / done:
    // accepted and ignored — this server always answers with a complete, self-contained pack.
  }
  return { wants, haves, shallows, depth };
}

function fetchCacheKey(repo: RepoRecord, variant: 'v2' | 'v0', args: FetchArgs): string {
  return `fetch|${variant}|${repo.objects.size}|${JSON.stringify([args.wants, args.haves, args.shallows, args.depth])}`;
}

function v2Fetch(ctx: Ctx, repo: RepoRecord, args: readonly string[]): Reply {
  const parsed = parseFetchArgs(args);
  const body = cachedBody(repo, fetchCacheKey(repo, 'v2', parsed), () => {
    const selection = selectFetchObjects(ctx.store.lookup(repo), parsed.wants, parsed.haves, parsed.shallows, parsed.depth);
    const parts: Buffer[] = [];
    const ackLines = selection.ack !== null ? [`ACK ${selection.ack}\n`, 'ready\n'] : ['NAK\n'];
    parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'flush']));
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      const info: string[] = [];
      for (const oid of selection.shallow) info.push(`shallow ${oid}\n`);
      for (const oid of selection.unshallow) info.push(`unshallow ${oid}\n`);
      parts.push(encodePktLines(['shallow-info\n', ...info, 'flush']));
    }
    const pack = writePack(selection.objects);
    parts.push(encodePktLine('packfile\n'));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  });
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body };
}

function v0Fetch(ctx: Ctx, repo: RepoRecord, packets: readonly Packet[]): Reply {
  // v0 is two flush-separated sections: wants (+ shallow/deepen), then haves + done.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') sections[sections.length - 1]!.push(stripLine(packet.payload.toString('utf8')));
  }
  const args = parseFetchArgs(sections.flat());
  const body = cachedBody(repo, fetchCacheKey(repo, 'v0', args), () => {
    const selection = selectFetchObjects(ctx.store.lookup(repo), args.wants, args.haves, args.shallows, args.depth);
    const parts: Buffer[] = [];
    if (selection.ack !== null) parts.push(encodePktLine(`ACK ${selection.ack}\n`));
    else parts.push(encodePktLine('NAK\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    const pack = writePack(selection.objects);
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  });
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body };
}

// -------------------------------------------------------------------------------------------
// receive-pack: pushes
// -------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(ctx: Ctx, repo: RepoRecord): Reply {
  const { packets, remainder } = decodePktLines(ctx.body);
  const commands: PushCommand[] = [];
  let wantsSideband = false;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = stripLine(packet.payload.toString('utf8'));
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) wantsSideband = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) {
      return pushReport(wantsSideband, 'unpack error: bad command line', []);
    }
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0 || !sawFlush) {
    return pushReport(wantsSideband, 'unpack error: no commands', []);
  }

  // Unpack: every object the pack carries joins the store before any ref moves.
  let unpackError: string | null = null;
  if (remainder.length > 0) {
    try {
      const read = readPack(remainder, ctx.store.lookup(repo));
      if (!read.checksumOk) unpackError = 'unpack error: pack checksum mismatch';
      else ctx.store.putObjects(repo, read.objects.values());
    } catch (err) {
      unpackError = `unpack error: ${(err as Error).message}`;
    }
  }
  if (unpackError !== null) {
    return pushReport(wantsSideband, unpackError, commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack error' })));
  }

  const lookup = ctx.store.lookup(repo);
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      const reason = command.oldOid === ZERO_OID ? 'already exists' : 'stale info';
      reports.push({ ref: command.ref, ok: false, reason });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = peelToCommit(command.oldOid, lookup);
      const newCommit = peelToCommit(command.newOid, lookup);
      const fastForward =
        oldCommit !== null && newCommit !== null ? isAncestor(oldCommit, newCommit, lookup) : command.oldOid === command.newOid;
      if (!fastForward) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }
  return pushReport(wantsSideband, 'unpack ok', reports);
}

/** The report-status stream, in band 1 when the client asked for side-band-64k, else raw. */
function pushReport(
  sideband: boolean,
  unpackLine: string,
  reports: ReadonlyArray<{ ref: string; ok: boolean; reason: string }>,
): Reply {
  const lines: string[] = [`${unpackLine}\n`];
  for (const report of reports) {
    lines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const inner = encodePktLines([...lines, 'flush']);
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([...sidebandPackets(1, inner), Buffer.from('0000', 'ascii')]);
  } else {
    body = inner;
  }
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT }, body };
}
