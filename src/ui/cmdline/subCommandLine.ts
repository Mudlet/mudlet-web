import { TabCompletionCycle } from '../tabCompletion';
import { cmdLinePlainText } from './plainText';

/**
 * What a named command line needs from the profile around it. Desktop's
 * TCommandLine reads all of this off its Host; here the ScriptingEngine
 * supplies it (see ScriptingEngine's constructor), and a line rendered before
 * there is an engine falls back to {@link DEFAULT_CMD_LINE_HOST}.
 */
export interface CmdLineHost {
    /** Mudlet's "Auto clear the input line after you sent text". */
    autoClear(): boolean;
    /** Mudlet's "Highlight history". */
    highlightHistory(): boolean;
    /** Host::isRemoteEchoingActive — the server took ECHO (a password prompt). */
    remoteEcho(): boolean;
    /** Mudlet's "Disable password masking". */
    disablePasswordMasking(): boolean;
    /** The Tab pool for the command line called `name` (see
     *  ScriptingAPI.cmdLineCompletionWords). */
    completionWords(name: string): readonly string[];
}

export const DEFAULT_CMD_LINE_HOST: CmdLineHost = {
    autoClear: () => false,
    highlightHistory: () => true,
    remoteEcho: () => false,
    disablePasswordMasking: () => false,
    completionWords: () => [],
};

/** The text of a command line and where its selection is ([start, end), a
 *  caret when they are equal). */
export interface CmdLineView {
    text: string;
    start: number;
    end: number;
}

const caretAtEnd = (text: string): CmdLineView => ({ text, start: text.length, end: text.length });
const allSelected = (text: string): CmdLineView => ({ text, start: 0, end: text.length });

/**
 * The keyboard behaviour of one named command line — a createCommandLine line
 * or a miniconsole's / user window's own — ported from desktop's TCommandLine,
 * which runs the same code for those as for the main one: input history on
 * Up/Down (with "Highlight history" prefix search), Tab completion, Escape,
 * and what Enter leaves behind. Web used to render these as bare inputs that
 * had none of it (#342).
 *
 * Kept outside React and held by the manager that owns the line, so the
 * history outlives the input being remounted (a dock, an undock, a hide). Each
 * method takes the line as it is and returns what it should become, or null
 * when the key changes nothing.
 */
export class SubCommandLine {
    /** mHistoryList: newest first, slot 0 the line being typed. */
    private historyList: string[] = [];
    /** mHistoryBuffer: which slot Up/Down stepped to; 0 is the typed line. */
    private historyBuffer = 0;
    /** mAutoCompletionCount: the history slot the prefix search is on. */
    private autoCompletionCount = -1;
    private readonly tab = new TabCompletionCycle();

    constructor(readonly name: string) {}

    /** The history, newest first (for tests and debugging). */
    get history(): readonly string[] {
        return this.historyList.filter(h => h !== '');
    }

    /**
     * Enter: the commands to dispatch (one per line, as TCommandLine splits
     * the box at line feeds) and what the box holds afterwards — emptied when
     * "auto clear" is on, else the same text, all selected so the next
     * keystroke replaces it. The text joins the history unless it is empty or
     * the server is masking input for a password.
     */
    enter(text: string, host: CmdLineHost): { commands: string[]; after: CmdLineView } {
        const plain = cmdLinePlainText(text);
        this.tab.reset();
        this.autoCompletionCount = -1;
        const autoClear = host.autoClear();
        if (text !== '' && (!host.remoteEcho() || host.disablePasswordMasking())) {
            this.historyBuffer = autoClear ? 0 : 1;
            this.historyList = this.historyList.filter(h => h !== plain);
            if (this.historyList.length > 0) this.historyList[0] = plain;
            else this.historyList.unshift(plain);
            this.historyList.unshift('');
        }
        return {
            // toPlainText(), then split at line feeds — so a NBSP goes out as
            // a space and U+2028/U+2029 break the line like a newline (#375).
            commands: plain.split('\n'),
            after: autoClear ? caretAtEnd('') : allSelected(text),
        };
    }

    /** TCommandLine::historyMove — a plain Up (`up` true) or Down. */
    historyMove(up: boolean, view: CmdLineView, host: CmdLineHost): CmdLineView | null {
        // Down on the line being typed puts it aside in the history and clears
        // the box, so it can be fetched back with Up later.
        if (!up && this.historyBuffer === 0 && view.text !== '') {
            this.historyList = this.historyList.filter(h => h !== view.text);
            if (this.historyList.length > 0) this.historyList[0] = view.text;
            else this.historyList.unshift(view.text);
            this.historyList.unshift('');
            return caretAtEnd('');
        }
        if (this.historyList.length === 0) return null;
        const shift = up ? 1 : -1;
        const highlight = host.highlightHistory();
        const selectedAll = view.end - view.start === view.text.length;
        if (selectedAll || view.text === '' || !highlight) {
            this.historyBuffer = Math.max(0, Math.min(this.historyBuffer + shift, this.historyList.length - 1));
            const text = this.historyList[this.historyBuffer];
            return highlight ? allSelected(text) : caretAtEnd(text);
        }
        this.autoCompletionCount += shift;
        return this.autoComplete(view);
    }

    /** TCommandLine::handleAutoCompletion — the history prefix search. */
    private autoComplete(view: CmdLineView): CmdLineView {
        const typed = view.text.slice(0, view.text.length - (view.end - view.start));
        const last = this.historyList.length - 1;
        this.autoCompletionCount = Math.max(0, Math.min(this.autoCompletionCount, last));
        for (let i = this.autoCompletionCount; i <= last; i++) {
            const h = this.historyList[i];
            if (h.slice(0, typed.length) !== typed) continue;
            this.autoCompletionCount = i;
            return { text: h, start: typed.length, end: h.length };
        }
        this.autoCompletionCount = -1;
        return caretAtEnd(typed);
    }

    /** Tab (`dir` 1) or Shift+Tab (-1); null when there is nothing to complete. */
    tabComplete(dir: 1 | -1, view: CmdLineView, host: CmdLineHost): { view: CmdLineView; proposal: string } | null {
        const step = this.tab.step(view.text, dir, () => host.completionWords(this.name));
        return step ? { view: caretAtEnd(step.text), proposal: step.proposal } : null;
    }

    /** Escape: leave Tab and history browsing, and select everything. */
    escape(view: CmdLineView): CmdLineView {
        this.tab.reset();
        this.autoCompletionCount = -1;
        this.historyBuffer = 0;
        return allSelected(view.text);
    }

    /** The player edited the text (TCommandLine::processNormalKey and the
     *  Backspace / Delete / Space cases): back on the typed line. */
    edited(): void {
        this.historyBuffer = 0;
        this.autoCompletionCount = -1;
    }
}
