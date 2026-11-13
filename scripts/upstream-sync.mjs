#!/usr/bin/env node
// Show and port changes from the upstream repository this deployment is based on.
//
//   npm run upstream:check                  report what is new since the pin
//   npm run upstream:diff -- <path>         print the upstream patch for one file
//   npm run upstream:apply -- <path>        apply it (refuses files already changed here)
//   npm run upstream:accept                 move the pin to the upstream head
//
// The pin lives in upstream.json. Keeping it explicit is what makes "what is
// new" answerable: this repository holds a snapshot of upstream, not its
// history, so git cannot compute a merge base on its own.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'upstream.json');

export function readUpstreamConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('upstream.json is not valid JSON');
  }
  for (const key of ['repository', 'branch', 'baseCommit']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error(`upstream.json is missing "${key}"`);
    }
  }
  if (!/^[0-9a-f]{7,40}$/i.test(config.baseCommit)) {
    throw new Error('upstream.json "baseCommit" must be a git commit hash');
  }
  return config;
}

export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [code, ...paths] = line.split('\t');
      const status = code[0];
      const renamed = status === 'R' || status === 'C';
      return {
        status,
        path: renamed ? paths[1] : paths[0],
        previousPath: renamed ? paths[0] : undefined,
      };
    });
}

// Files this repository changed since the pin. A file changed on both sides is
// the only case that needs a human decision; everything else applies cleanly.
export function portPlan(upstreamFiles, localFiles) {
  const local = new Map(localFiles.map(entry => [entry.path, entry.status]));
  return upstreamFiles.map(entry => {
    const touching = [entry.path, entry.previousPath].filter(Boolean);
    const conflict = touching.find(path => local.get(path) === 'M');
    const removed = touching.find(path => local.get(path) === 'D');
    const added = touching.find(path => local.get(path) === 'A');
    const note = conflict
      ? 'changed here too - port by hand'
      : removed
        ? 'deleted here - decide whether to keep it deleted'
        : added
          ? 'added here too - check for overlap'
          : '';
    return { ...entry, note };
  });
}

const short = sha => sha.slice(0, 7);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function git(args, input) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input });
  if (result.error) throw result.error;
  return result;
}

function requireGit(args, input) {
  const result = git(args, input);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout;
}

function commitDate(sha) {
  return requireGit(['show', '-s', '--format=%ad', '--date=short', sha]).trim();
}

function changedFiles(from, to) {
  // No second revision means "compare with the working tree", so uncommitted
  // edits and staged work count as local changes too.
  const args = ['diff', '--name-status', '-M', from];
  if (to) args.push(to);
  return parseNameStatus(requireGit(args));
}

function localChanges(base) {
  const changes = changedFiles(base);
  const known = new Set(changes.flatMap(entry => [entry.path, entry.previousPath].filter(Boolean)));
  for (const path of requireGit(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    if (!known.has(path)) changes.push({ status: 'A', path });
  }
  return changes;
}

function ensureRemote(repository) {
  const existing = git(['remote', 'get-url', 'upstream']);
  if (existing.status !== 0) {
    requireGit(['remote', 'add', 'upstream', repository]);
    return;
  }
  if (existing.stdout.trim() !== repository) {
    requireGit(['remote', 'set-url', 'upstream', repository]);
    process.stderr.write(`note: remote "upstream" now points at ${repository}\n`);
  }
}

function resolveUpstream(config, fetch) {
  ensureRemote(config.repository);
  if (fetch) {
    process.stderr.write(`fetching ${config.repository} ${config.branch}...\n`);
    requireGit(['fetch', '--quiet', 'upstream', config.branch]);
  }
  const ref = `upstream/${config.branch}`;
  return requireGit(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function baseExists(baseCommit) {
  return git(['cat-file', '-e', `${baseCommit}^{commit}`]).status === 0;
}

function requireBase(config) {
  if (baseExists(config.baseCommit)) return;
  throw new Error(
    [
      `Pinned commit ${short(config.baseCommit)} does not exist after fetching upstream.`,
      'Upstream may have rewritten history. Compare the trees, set baseCommit in',
      'upstream.json to the newest commit whose changes this tree already has,',
      'then run npm run upstream:check again.',
    ].join('\n'),
  );
}

function listCommits(base, remote, limit) {
  const format = '%H%x1f%ad%x1f%s';
  const lines = requireGit(['log', `--format=${format}`, '--date=short', `${base}..${remote}`])
    .split('\n')
    .filter(Boolean);
  return {
    total: lines.length,
    shown: lines.slice(0, limit).map(line => {
      const [sha, date, subject] = line.split('\x1f');
      return { sha, date, subject };
    }),
  };
}

function report(config, { fetch, all }) {
  const sha = resolveUpstream(config, fetch);
  requireBase(config);
  const ahead = Number(requireGit(['rev-list', '--count', `${config.baseCommit}..${sha}`]).trim());

  const out = [];
  out.push(`Upstream  ${config.repository} (${config.branch})`);
  out.push(`Pinned    ${short(config.baseCommit)}  ${commitDate(config.baseCommit)}`);
  if (ahead === 0) {
    out.push(`Remote    ${short(sha)}  ${commitDate(sha)}  up to date`);
    out.push('');
    out.push('Nothing new since the pin.');
    return out.join('\n');
  }

  const { total, shown } = listCommits(config.baseCommit, sha, 25);
  out.push(`Remote    ${short(sha)}  ${commitDate(sha)}  ${plural(ahead, 'commit')} ahead`);
  out.push('');
  out.push(`${plural(total, 'new commit')}:`);
  for (const commit of shown) {
    out.push(`  ${short(commit.sha)}  ${commit.date}  ${commit.subject}`);
  }
  if (total > shown.length) out.push(`  ... and ${total - shown.length} more`);

  const files = portPlan(changedFiles(config.baseCommit, sha), localChanges(config.baseCommit));
  const shortstat = requireGit(['diff', '--shortstat', config.baseCommit, sha]).trim();
  const added = Number(/(\d+) insertion/.exec(shortstat)?.[1] ?? 0);
  const removed = Number(/(\d+) deletion/.exec(shortstat)?.[1] ?? 0);
  const width = Math.min(52, Math.max(...files.map(file => file.path.length), 4));
  const shownFiles = all ? files : files.slice(0, 40);

  out.push('');
  out.push(`${plural(files.length, 'changed file')}  +${added} -${removed}`);
  for (const file of shownFiles) {
    const label = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
    out.push(`  ${file.status}  ${label.padEnd(width)}  ${file.note || 'applies cleanly'}`.trimEnd());
  }
  if (shownFiles.length < files.length) {
    out.push(`  ... and ${files.length - shownFiles.length} more (npm run upstream:check -- --all)`);
  }

  const risky = files.filter(file => file.note);
  const mcp = files.filter(file => file.path.startsWith('apps/cloudflare-obsidian-mcp/'));
  const dependencies = files.filter(file => /^(package(-lock)?\.json|\.nvmrc)$/.test(file.path));

  out.push('');
  if (risky.length) {
    const listed = risky.slice(0, 5).map(file => file.path).join(', ');
    out.push(`Needs judgement: ${risky.length <= 5 ? listed : `${listed} and ${risky.length - 5} more`}`);
  }
  if (mcp.length) {
    out.push(`MCP-only: ${plural(mcp.length, 'file')} under apps/cloudflare-obsidian-mcp - safe to skip for this storage-only deployment.`);
  }
  if (dependencies.length) {
    out.push(`Dependencies changed (${dependencies.map(file => file.path).join(', ')}) - run npm ci and the full test suite after porting.`);
  }

  const clean = files.find(file => !file.note);
  out.push('');
  out.push('Next:');
  if (clean) out.push(`  npm run upstream:diff -- ${clean.path}`);
  if (clean) out.push(`  npm run upstream:apply -- ${clean.path}`);
  if (risky.length) out.push('  # then port the files marked "port by hand"');
  out.push('  npm test && npm run check:storage');
  out.push('  npm run upstream:accept');
  return out.join('\n');
}

function showDiff(config, path) {
  if (!path) throw new Error('Usage: npm run upstream:diff -- <path>');
  const sha = resolveUpstream(config, true);
  requireBase(config);
  const patch = requireGit(['diff', config.baseCommit, sha, '--', path]);
  if (!patch.trim()) throw new Error(`${path} did not change upstream since the pin`);
  process.stdout.write(patch);
}

function applyDiff(config, paths, threeWay) {
  if (!paths.length) throw new Error('Usage: npm run upstream:apply -- <path> [<path>...]');
  const sha = resolveUpstream(config, true);
  requireBase(config);
  const upstream = changedFiles(config.baseCommit, sha);
  const local = new Map(localChanges(config.baseCommit).map(entry => [entry.path, entry.status]));
  let failed = false;

  for (const path of paths) {
    const file = upstream.find(entry => entry.path === path || entry.previousPath === path);
    if (!file) {
      process.stderr.write(`${path}: not changed upstream since the pin\n`);
      failed = true;
      continue;
    }
    const localStatus = local.get(path);
    if (localStatus && !threeWay) {
      process.stderr.write(`${path}: changed here too (${localStatus}) - use upstream:diff and port by hand, or pass --3way\n`);
      failed = true;
      continue;
    }
    // A rename touches both paths, so the patch has to be limited to both.
    const patch = requireGit(['diff', '--binary', config.baseCommit, sha, '--', file.previousPath ?? file.path, file.path]);
    if (!patch.trim()) {
      process.stderr.write(`${path}: no patch from upstream\n`);
      failed = true;
      continue;
    }
    const result = git(['apply', ...(threeWay ? ['--3way'] : []), '-'], patch);
    if (result.status !== 0) {
      process.stderr.write(`${path}: patch did not apply\n${(result.stderr || '').trim()}\n`);
      failed = true;
      continue;
    }
    process.stdout.write(`${path}: applied${threeWay ? ' (3-way, changes are staged)' : ''}\n`);
  }
  if (failed) process.exitCode = 1;
}

function accept(config, flags) {
  const sha = resolveUpstream(config, true);
  if (sha === config.baseCommit) {
    process.stdout.write(`Already pinned to ${short(sha)}.\n`);
    return;
  }
  if (!flags.has('--yes')) {
    const ahead = Number(requireGit(['rev-list', '--count', `${config.baseCommit}..${sha}`]).trim());
    process.stdout.write(`This marks ${plural(ahead, 'upstream commit')} as reviewed and stops listing them.\n`);
    process.stdout.write('Re-run with --yes once the ported work is tested:\n  npm run upstream:accept -- --yes\n');
    process.exitCode = 1;
    return;
  }
  const next = { ...config, baseCommit: sha, syncedAt: new Date().toISOString().slice(0, 10) };
  writeFileSync(CONFIG, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`Pinned to ${short(sha)} (${commitDate(sha)}). Commit upstream.json with the ported changes.\n`);
}

function main(argv) {
  const [command = 'status', ...rest] = argv;
  const config = readUpstreamConfig(readFileSync(CONFIG, 'utf8'));
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const paths = rest.filter(arg => !arg.startsWith('--'));

  switch (command) {
    case 'status':
    case 'check':
      process.stdout.write(`${report(config, { fetch: !flags.has('--no-fetch'), all: flags.has('--all') })}\n`);
      break;
    case 'diff':
      showDiff(config, paths[0]);
      break;
    case 'apply':
      applyDiff(config, paths, flags.has('--3way'));
      break;
    case 'accept':
      accept(config, flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(usage());
      break;
    default:
      throw new Error(`Unknown command "${command}"\n\n${usage()}`);
  }
}

function usage() {
  return [
    'Usage: node scripts/upstream-sync.mjs <command>',
    '',
    '  status [--no-fetch]          what changed upstream since the pin',
    '  diff <path>                  print the upstream patch for one file',
    '  apply <path...> [--3way]     apply it (refuses files changed here)',
    '  accept [--yes]               move the pin to the upstream head',
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
