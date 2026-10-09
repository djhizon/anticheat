import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface AppIdentity {
  pid: number;
  bundleId: string;
  bundlePath: string;
  executablePath: string;
  launchDate: number;
}
export interface NativeApp {
  identity: AppIdentity;
  name: string;
  protected: boolean;
  exempt: boolean;
  reason: string;
}
export interface AppTarget {
  id: string;
  name: string;
  protected: boolean;
  exempt: boolean;
  reason: string;
  canForce: boolean;
}
export type CloseMode = 'quit' | 'force';
export interface ActionResult {
  status: 'requested' | 'refused' | 'cancelled' | 'error';
  message: string;
}
export type HelperCall = (action: 'list' | CloseMode, target?: AppIdentity) => Promise<unknown>;

export function createHelperCall(executable: string): HelperCall {
  return (action, target) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        [],
        { timeout: 6000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(new Error('Native app check unavailable.'));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('Invalid native app response.'));
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(
        JSON.stringify({ action, target, hostPid: process.pid, hostExecutable: process.execPath }),
      );
    });
}

const identityKey = (i: AppIdentity): string =>
  JSON.stringify([i.pid, i.bundleId, i.bundlePath, i.executablePath, i.launchDate]);
function entries(value: unknown): NativeApp[] {
  if (!value || typeof value !== 'object' || !('apps' in value) || !Array.isArray(value.apps)) {
    throw new Error('Native app discovery failed. Keep the local servers running and retry.');
  }
  const apps: NativeApp[] = value.apps;
  for (const a of apps) {
    const i = a?.identity;
    if (
      !i ||
      !Number.isSafeInteger(i.pid) ||
      i.pid <= 1 ||
      !Number.isFinite(i.launchDate) ||
      i.launchDate <= 0 ||
      ![i.bundleId, i.bundlePath, i.executablePath, a.name].every(
        (s) => typeof s === 'string' && s.length > 0,
      ) ||
      typeof a.protected !== 'boolean' ||
      typeof a.exempt !== 'boolean' ||
      typeof a.reason !== 'string'
    ) {
      throw new Error('Incomplete native app identity. No application was closed.');
    }
  }
  if (!apps.length || new Set(apps.map((a) => a.identity.pid)).size !== apps.length) {
    throw new Error('Native app inventory is unavailable or ambiguous.');
  }
  return apps;
}

/** Authority stays in main/native code. Renderer receives opaque, instance-bound IDs. */
export function createAppController(options: {
  call: HelperCall;
  confirm: (name: string, mode: CloseMode) => Promise<boolean>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let known = new Map<string, NativeApp>();
  const attempts = new Map<string, number>();
  let generation = 0;
  let busy = false;
  const forceEligible = (a: NativeApp): boolean => {
    const attempted = attempts.get(identityKey(a.identity));
    return attempted !== undefined && now() - attempted >= 3000 && now() - attempted <= 60000;
  };
  async function scan(): Promise<NativeApp[]> {
    return entries(await options.call('list'));
  }
  async function current(target: NativeApp): Promise<NativeApp | undefined> {
    return (await scan()).find((a) => identityKey(a.identity) === identityKey(target.identity));
  }
  const refused = (): ActionResult => ({
    status: 'refused',
    message: 'Target changed, is protected, or is not eligible. Re-check the environment.',
  });
  return {
    reset(): void {
      generation++;
      known.clear();
      attempts.clear();
    },
    async list(): Promise<AppTarget[]> {
      const epoch = generation;
      const apps = await scan();
      if (epoch !== generation) throw new Error('The application page changed. Retry.');
      const previous = new Map([...known].map(([id, a]) => [identityKey(a.identity), id]));
      const next = new Map<string, NativeApp>();
      const result = apps.map((a) => {
        const id = previous.get(identityKey(a.identity)) ?? randomUUID();
        next.set(id, a);
        return {
          id,
          name: a.name,
          protected: a.protected,
          exempt: a.exempt,
          reason: a.reason,
          canForce: !a.protected && !a.exempt && forceEligible(a),
        };
      });
      known = next;
      const live = new Set(apps.map((a) => identityKey(a.identity)));
      for (const [key, at] of attempts)
        if (!live.has(key) || now() - at > 60000) attempts.delete(key);
      return result;
    },
    async close(id: unknown, mode: unknown): Promise<ActionResult> {
      if (busy || typeof id !== 'string' || (mode !== 'quit' && mode !== 'force')) return refused();
      const target = known.get(id);
      if (!target || target.protected || target.exempt) return refused();
      busy = true;
      const epoch = generation;
      try {
        const before = await current(target);
        if (
          !before ||
          before.protected ||
          before.exempt ||
          epoch !== generation ||
          (mode === 'force' && !forceEligible(before))
        )
          return refused();
        if (!(await options.confirm(before.name, mode)))
          return { status: 'cancelled', message: 'No close request was sent.' };
        // Confirmation may stay open while processes exit/restart or the page navigates.
        const after = await current(target);
        if (
          !after ||
          after.protected ||
          after.exempt ||
          epoch !== generation ||
          (mode === 'force' && !forceEligible(after))
        )
          return refused();
        const key = identityKey(after.identity);
        if (mode === 'force') attempts.delete(key); // one confirmed escalation per graceful attempt
        const reply = await options.call(mode, after.identity);
        if (
          !reply ||
          typeof reply !== 'object' ||
          !('status' in reply) ||
          !['requested', 'refused'].includes(String(reply.status))
        ) {
          throw new Error('Native action could not be verified.');
        }
        if (mode === 'quit' && epoch === generation) attempts.set(key, now());
        return reply.status === 'requested'
          ? {
              status: 'requested',
              message:
                mode === 'quit'
                  ? 'Quit requested. Check for a save dialog, then re-check. Force Quit becomes available after 3 seconds if it is still running.'
                  : 'Force Quit requested. Re-check to verify the app exited.',
            }
          : {
              status: 'refused',
              message:
                'macOS did not accept the request. Re-check; no automatic escalation will occur.',
            };
      } catch {
        return {
          status: 'error',
          message:
            'The app-close check failed. Re-check the environment; no automatic retry or force quit will occur.',
        };
      } finally {
        busy = false;
      }
    },
  };
}
