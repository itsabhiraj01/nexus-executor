import { spawn } from 'node:child_process';

/**
 * `nexus-executor logs` — tail the service log. Under systemd installs the
 * service logs to the journal; otherwise the configured log file
 * (EXECUTOR_LOG_FILE). Fire-and-forget: spawns tail and inherits stdio.
 */

export interface LogsOptions { argv: string[]; lines?: number }

export function tailLogs(opts: LogsOptions): void {
  const lines = opts.lines ?? 50;
  const logFile = process.env.EXECUTOR_LOG_FILE;
  const cmd = logFile
    ? ['tail', '-n', String(lines), '-f', logFile]
    : ['journalctl', '-u', 'nexus-executor', '-n', String(lines), '-f'];
  const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`logs: could not run ${cmd[0]}: ${err.message}`);
    process.exitCode = 1;
  });
}