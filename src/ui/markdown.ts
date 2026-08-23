import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true });

interface RenderOptions {
    /** Turn a single newline into a `<br>`. On for user-written notes, where
     *  `gfm + breaks` matches the behavior most note apps render. Off for
     *  hard-wrapped prose documents, where source line breaks are just wrapping
     *  and rendering them would shred every paragraph — which is also how GitHub
     *  renders a `.md` file. */
    breaks?: boolean;
}

export function renderMarkdown(src: string, { breaks = true }: RenderOptions = {}): string {
    const html = marked.parse(src, { async: false, breaks }) as string;
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}
