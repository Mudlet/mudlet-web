/** Byte count for a person: "912 B", "48 KB", "3.4 MB". Rounded hard on
 *  purpose — these appear next to a control, where the order of magnitude is
 *  the whole message and a second decimal place is noise. */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
