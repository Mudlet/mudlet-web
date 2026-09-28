/**
 * Registry for Mudlet `createTextEdit` widgets — a multi-line text editor pane.
 *
 * This is the data model behind the `*TextEdit*` Lua API (text content, the
 * editor properties scripts set, and geometry/visibility). The on-screen
 * QPlainTextEdit-equivalent rendering is not wired yet; scripts can create
 * editors and round-trip their text/properties, which is what the Mudlet API
 * surface (and the busted TextEdit spec) exercises.
 */
export interface TextEditState {
    parent: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    readOnly: boolean;
    placeholder: string;
    styleSheet: string;
    font: string;
    fontSize: number;
    tabMovesFocus: boolean;
    visible: boolean;
}

export class TextEditManager {
    private edits = new Map<string, TextEditState>();

    has(name: string): boolean {
        return this.edits.has(name);
    }

    /** Read-only handle on a text edit's stored state, for the geometry and
     *  visibility getters (getWindowGeometry, windowVisible). */
    get(name: string): Readonly<TextEditState> | undefined {
        return this.edits.get(name);
    }

    /** Create a text edit. False when one of that name already exists — it is
     *  left as it was, as TMainConsole::createTextBox leaves it. */
    create(
        name: string,
        opts: { parent: string; x: number; y: number; width: number; height: number },
    ): boolean {
        if (this.edits.has(name)) return false;
        this.edits.set(name, {
            parent: opts.parent,
            x: opts.x, y: opts.y, width: opts.width, height: opts.height,
            text: '',
            readOnly: false,
            placeholder: '',
            styleSheet: '',
            font: '',
            fontSize: 0,
            tabMovesFocus: false,
            visible: true,
        });
        return true;
    }

    destroy(name: string): boolean {
        return this.edits.delete(name);
    }

    /** Returns the editor's text, or null when no editor of that name exists. */
    getText(name: string): string | null {
        return this.edits.get(name)?.text ?? null;
    }

    setText(name: string, text: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.text = text;
        return true;
    }

    clear(name: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.text = '';
        return true;
    }

    setReadOnly(name: string, value: boolean): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.readOnly = value;
        return true;
    }

    setPlaceholder(name: string, text: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.placeholder = text;
        return true;
    }

    setStyleSheet(name: string, css: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.styleSheet = css;
        return true;
    }

    setFont(name: string, font: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.font = font;
        return true;
    }

    setFontSize(name: string, size: number): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.fontSize = size;
        return true;
    }

    setTabMovesFocus(name: string, value: boolean): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.tabMovesFocus = value;
        return true;
    }

    show(name: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.visible = true;
        return true;
    }

    hide(name: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.visible = false;
        return true;
    }

    move(name: string, x: number, y: number): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.x = x;
        e.y = y;
        return true;
    }

    /** Mudlet setWindow — reparent a text edit into another window. */
    setParent(name: string, parent: string): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.parent = parent;
        return true;
    }

    resize(name: string, width: number, height: number): boolean {
        const e = this.edits.get(name);
        if (!e) return false;
        e.width = width;
        e.height = height;
        return true;
    }
}
