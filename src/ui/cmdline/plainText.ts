/**
 * What a command line's text becomes once it leaves the box — desktop's
 * TCommandLine reads it with QPlainTextEdit::toPlainText(), and
 * QTextDocument::toPlainText turns a non-breaking space (U+00A0) into an
 * ordinary space and the Unicode line and paragraph separators (U+2028,
 * U+2029) into line feeds. So text pasted from a web page or a chat app sends
 * `pg x`, not `pg<NBSP>x`, and a U+2028 splits the command in two, as a typed
 * newline does. getCmdLine() reads the same plain text (#375).
 *
 * Every replacement is one UTF-16 unit for one, so caret offsets taken on the
 * raw text still hold on the result.
 */
export function cmdLinePlainText(text: string): string {
    return text.replace(/\u00A0/g, ' ').replace(/[\u2028\u2029]/g, '\n');
}

/** The commands one Enter sends: the plain text, one per line, as
 *  TCommandLine::enterCommand splits it before Host::send. */
export function cmdLineCommands(text: string): string[] {
    return cmdLinePlainText(text).split('\n');
}
