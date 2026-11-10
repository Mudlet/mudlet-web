// vitest's stand-in for src/mud/triggers/pcre/pcre2WasmSource.ts: the committed
// module, read from disk, as the app fetches it from beside the page.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function loadPcre2Wasm(): Promise<ArrayBuffer> {
    const bytes = readFileSync(resolve(__dirname, '../../wasm/pcre2/libpcre2.wasm'));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
