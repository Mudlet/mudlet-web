// Types for check-vendored-paths.mjs, so tests/scripts/checkVendoredPaths.test.ts
// type-checks without allowJs.
export interface VendoredEntry { path: string; script: string }
export interface Offending { path: string; script: string }

export const SYNC_BRANCHES: Record<string, string[]>;
export const VENDORED: VendoredEntry[];
export const HAND_MAINTAINED: string[];
export function vendoredEntry(path: string): VendoredEntry | null;
export function offendingPaths(
    paths: string[],
    options?: { headBranch?: string; sameRepo?: boolean },
): Offending[];
export function formatReport(offending: Offending[]): string;
