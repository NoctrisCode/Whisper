// PreToolUse hook: blocks `git push` targeting protected branches.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const PROTECTED = new Set(['master', 'develop']);
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_ALL_FLAGS = new Set(['--all', '--mirror', '--branches']);

const readStdin = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
};

const tokenize = (segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));

const splitSegments = (command) => command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);

const git = (cwd, args) => {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
};

const stripRef = (ref) => ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');

// Returns { cwd, args } after `git push`, or null if segment is not a push.
const parsePush = (tokens, baseCwd) => {
    const gitIdx = tokens.findIndex((t) => t === 'git' || t === 'git.exe');
    if (gitIdx === -1) return null;
    const step = (i, cwd) => {
        const t = tokens[i];
        if (t === undefined) return null;
        if (t === 'push') return { cwd, args: tokens.slice(i + 1) };
        if (t === '-C') return step(i + 2, resolve(cwd, tokens[i + 1] ?? '.'));
        if (GIT_OPTS_WITH_VALUE.has(t)) return step(i + 2, cwd);
        if (t.startsWith('-')) return step(i + 1, cwd);
        return null;
    };
    return step(gitIdx + 1, baseCwd);
};

const positionals = (args) =>
    args.reduce(
        (acc, a) => {
            if (acc.skip) return { ...acc, skip: false };
            if (PUSH_OPTS_WITH_VALUE.has(a)) return { ...acc, skip: true };
            if (a.startsWith('-')) return acc;
            return { ...acc, list: [...acc.list, a] };
        },
        { skip: false, list: [] },
    ).list;

const currentBranch = (cwd) => git(cwd, ['branch', '--show-current']);

const defaultPushTarget = (cwd) => {
    const push = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
    return push ? push.replace(/^[^/]+\//, '') : currentBranch(cwd);
};

const refspecTarget = (cwd, refspec) => {
    const dst = refspec.includes(':') ? refspec.split(':').pop() : refspec;
    const name = stripRef(dst);
    return name === 'HEAD' ? currentBranch(cwd) : name;
};

const pushTargets = ({ cwd, args }) => {
    if (args.some((a) => PUSH_ALL_FLAGS.has(a))) return [...PROTECTED];
    const refspecs = positionals(args).slice(1);
    return refspecs.length === 0 ? [defaultPushTarget(cwd)] : refspecs.map((r) => refspecTarget(cwd, r));
};

const blockedTargets = (command, cwd) =>
    splitSegments(command)
        .map((s) => parsePush(tokenize(s), cwd))
        .filter(Boolean)
        .flatMap(pushTargets)
        .filter((b) => PROTECTED.has(b));

const main = async () => {
    const input = JSON.parse(await readStdin());
    const command = input.tool_input?.command ?? '';
    const blocked = [...new Set(blockedTargets(command, input.cwd ?? process.cwd()))];
    if (blocked.length === 0) process.exit(0);
    process.stderr.write(`Blocked: push to protected branch(es) ${blocked.join(', ')}. Push to a feature branch and open a PR.\n`);
    process.exit(2);
};

main().catch(() => process.exit(0));
