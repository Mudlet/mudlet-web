/**
 * Lookup over one of the run-length tables in unicodeTables.generated.ts.
 *
 * The Basic Multilingual Plane — where nearly every character a game sends
 * lives — is expanded into a flat array on first use, so a lookup there is a
 * single index. The rest stays as runs and is binary-searched.
 */
export interface RunLookup {
    (cp: number): number;
}

const BMP = 0x10000;

export function runLookup<T extends Uint8Array | Uint16Array>(encoded: string, make: (n: number) => T): RunLookup {
    let bmp: T | null = null;
    let starts: Int32Array;
    let values: T;

    const decode = (): T => {
        const parts = encoded.split(',');
        const runs = parts.length / 2;
        starts = new Int32Array(runs);
        values = make(runs);
        const flat = make(BMP);
        let at = 0;
        for (let r = 0; r < runs; r++) {
            const length = parseInt(parts[2 * r], 36);
            const value = parseInt(parts[2 * r + 1], 36);
            starts[r] = at;
            values[r] = value;
            if (at < BMP) flat.fill(value, at, Math.min(at + length, BMP));
            at += length;
        }
        bmp = flat;
        return flat;
    };

    return (cp: number): number => {
        const flat = bmp ?? decode();
        if (cp < BMP) return flat[cp];
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= cp) lo = mid;
            else hi = mid - 1;
        }
        return values[lo];
    };
}
