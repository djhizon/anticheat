export interface DesktopAppTarget {
  id: string;
  name: string;
  protected: boolean;
  exempt: boolean;
  reason: string;
  canForce: boolean;
}
export interface DesktopAppsBridge {
  getDisplayCount(): Promise<number>;
  getEnvironmentRisk?(): Promise<{ virtualMachine: string | null; captureDisplays: string[] }>;
  listAppTargets(): Promise<unknown>;
  closeAppTarget(id: string, mode: 'quit' | 'force'): Promise<{ status: string; message: string }>;
}
export function desktopAppsBridge(): DesktopAppsBridge | undefined {
  return (window as Window & { electronExam?: DesktopAppsBridge }).electronExam;
}
export function parseAppTargets(value: unknown): DesktopAppTarget[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (a) =>
        a &&
        typeof a === 'object' &&
        typeof a.id === 'string' &&
        a.id.length > 0 &&
        typeof a.name === 'string' &&
        typeof a.reason === 'string' &&
        typeof a.protected === 'boolean' &&
        typeof a.exempt === 'boolean' &&
        typeof a.canForce === 'boolean',
    ) ||
    new Set(value.map((a) => a.id)).size !== value.length
  ) {
    throw new Error('Invalid desktop inventory.');
  }
  return value;
}
