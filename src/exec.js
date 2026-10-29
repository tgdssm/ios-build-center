import { spawn } from 'node:child_process';

/**
 * Runs a program with an argv array. There is no shell anywhere in this file, so a
 * branch name can never be interpreted as a command, a pipe or a redirection.
 */
export function run({ program, args, cwd, env, onLine, timeoutMs, signalRef }) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env,
      detached: true, // own process group, so cancel kills the children too
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (signalRef) signalRef.child = child;

    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signalRef) signalRef.child = null;
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 10_000);
    }, timeoutMs);

    const pump = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onLine(line);
      });
      stream.on('end', () => {
        if (buffer.trim()) onLine(buffer);
      });
    };
    pump(child.stdout);
    pump(child.stderr);

    child.on('error', (err) => finish({ code: -1, error: err.message, timedOut }));
    child.on('close', (code, signal) => finish({ code: code ?? -1, signal, timedOut }));
  });
}

/** Kills the whole process group of a spawned child — never a kill by process name. */
export function killTree(child, signal) {
  if (!child || child.killed || child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Convenience wrapper for short commands whose stdout we want as a string. */
export async function capture(program, args, opts = {}) {
  let out = '';
  const result = await run({
    program,
    args,
    cwd: opts.cwd,
    env: opts.env ?? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, ...opts.extraEnv },
    onLine: (line) => {
      out += `${line}\n`;
    },
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  return { ...result, stdout: out.trim() };
}
