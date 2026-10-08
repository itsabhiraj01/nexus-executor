import { pathToFileURL } from 'node:url';
import { EXECUTOR_VERSION } from '../config.js';

/**
 * `nexus-executor` subcommand dispatch. The bin (`bin/nexus-executor`)
 * dynamic-imports this module and calls `runCli` with `process.argv.slice(2)`.
 *
 * Commands are wired across the CLI tasks; `status` is the bare-command
 * summary. `exit`/`stdout` options keep it testable without spawning a
 * process.
 */

export interface CliRunOptions {
  exit?: (code: number) => void;
  stdout?: (text: string) => void;
}

const HELP = `nexus-executor — Nexus executor control

Usage:
  nexus-executor                show status summary
  nexus-executor pair           pair/enroll this executor (interactive)
  nexus-executor pair --gateway URL --code CODE   pair non-interactively
  nexus-executor pair --hub URL --code CODE       use direct transport
  nexus-executor unpair         remove pairing (two-step on a live machine)
  nexus-executor status         show pairing + runtime status  (--json)
  nexus-executor version        print versions
  nexus-executor doctor         self-check pairing status      (--json)
  nexus-executor config         print effective config
  nexus-executor logs           tail the service log
  nexus-executor update         pull, build, restart (best-effort)
  nexus-executor help           show this help

Run 'nexus-executor <cmd> --help' for flags.
`;

export async function runCli(
  argv: string[],
  opts: CliRunOptions = {},
): Promise<string> {
  const print = opts.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const exit = opts.exit ?? ((code: number) => { process.exitCode = code; });
  const [command, ...rest] = argv;

  // Bare `nexus-executor` → a compact status summary (the full-screen TUI is
  // a later slice; this is deliberately a text report for v1).
  if (!command) {
    const { statusFromCli } = await import('./status.js');
    const text = await statusFromCli({ argv: [] });
    print(text);
    return text;
  }

  switch (command) {
    case 'version': {
      const { versionText } = await import('./version.js');
      const text = versionText();
      print(text);
      return text;
    }
    case 'pair': {
      const { pairFromCli } = await import('./pair.js');
      const result = await pairFromCli({ argv: rest });
      const line = result.transport === 'gateway'
        ? `Paired "${result.name}" via ${result.gatewayUrl ?? 'gateway'} (executor ${result.executorId ?? '?'}).`
        : `Paired "${result.name}" with the hub${result.executorId ? ` (id ${result.executorId})` : ''}.`;
      print(line);
      return line;
    }
    case 'unpair': {
      const { unpair } = await import('./unpair.js');
      const text = await unpair({ argv: rest });
      print(text);
      return text;
    }
    case 'status': {
      const { statusFromCli } = await import('./status.js');
      const text = await statusFromCli({ argv: rest });
      print(text);
      return text;
    }
    case 'doctor': {
      const { doctor } = await import('./doctor.js');
      const text = await doctor({ argv: rest });
      print(text);
      return text;
    }
    case 'config': {
      const { configText } = await import('./config.js');
      const text = configText();
      print(text);
      return text;
    }
    case 'logs': {
      const { tailLogs } = await import('./logs.js');
      tailLogs({ argv: rest });
      return '';
    }
    case 'update': {
      const { update } = await import('./update.js');
      const text = update();
      print(text);
      return text;
    }
    case 'help': {
      print(HELP);
      return HELP;
    }
    default:
      print(HELP);
      exit(2);
      return HELP;
  }
}

// Direct invocation (`tsx src/cli/cli.ts pair ...`) runs the CLI without
// needing a build — the path used by `npm run pair`. `pathToFileURL` mirrors
// the standalone-check pattern in `src/pairing.ts`.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}