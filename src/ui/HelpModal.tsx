import { useEffect, useMemo, useRef, useState } from 'react';
import { ResizableModal } from './ResizableModal';
import { useAppStore } from '../storage';
import { renderMarkdown } from './markdown';
import { DEFAULT_HELP_TOPIC, HELP_TOPICS, searchHelpTopics, topicForHref } from './helpTopics';
import './HelpModal.css';

interface HelpModalProps {
    /** Bounds are remembered per profile; omitted on the start screen, where
     *  there is no active connection to key them by. */
    connectionId?: string;
    /** Topic to open on — defaults to the migration guide. */
    initialTopic?: string;
    /** Extra class on the dialog. Used by a caller that opens the manual over
     *  its own dialog rather than instead of it, to lift this one above the
     *  `.modal` stacking level it would otherwise sit under. */
    className?: string;
    onClose: () => void;
}

const MUDLET_WIKI = 'https://wiki.mudlet.org/w/Manual:Contents';

export function HelpModal({ connectionId, initialTopic, className, onClose }: HelpModalProps) {
    const savedBounds = useAppStore(s => (connectionId ? s.connectionModalBounds[connectionId]?.['help'] : undefined));
    const saveModalBounds = useAppStore(s => s.saveModalBounds);

    const [topicId, setTopicId] = useState(initialTopic ?? DEFAULT_HELP_TOPIC);
    const [query, setQuery] = useState('');
    const contentRef = useRef<HTMLDivElement>(null);

    const matches = useMemo(() => searchHelpTopics(query), [query]);
    const topic = HELP_TOPICS.find(t => t.id === topicId) ?? HELP_TOPICS[0];
    // `breaks: false` — these files are hard-wrapped so they read well as source
    // on GitHub; rendering those wraps as <br> would break every paragraph up.
    const html = useMemo(() => renderMarkdown(topic.markdown, { breaks: false }), [topic]);

    // Back to the top whenever the topic changes — otherwise a short page opens
    // scrolled to wherever the previous long one was.
    useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [topicId]);

    // The markdown is written to work on GitHub too, so its links are relative
    // paths between the source files. Rewrite them after render: our own files
    // become topic switches, everything else opens in a new tab.
    useEffect(() => {
        const root = contentRef.current;
        if (!root) return;
        for (const a of Array.from(root.querySelectorAll('a[href]'))) {
            const href = a.getAttribute('href') ?? '';
            const target = topicForHref(href);
            if (target) {
                a.setAttribute('data-help-topic', target);
                a.removeAttribute('target');
            } else if (/^https?:/i.test(href)) {
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noopener noreferrer');
            }
        }
    }, [html]);

    const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const link = (e.target as HTMLElement).closest?.('a[data-help-topic]');
        if (!link) return;
        e.preventDefault();
        setTopicId(link.getAttribute('data-help-topic')!);
    };

    return (
        <ResizableModal
            title="Help"
            onClose={onClose}
            savedBounds={savedBounds}
            onBoundsChange={connectionId ? b => saveModalBounds(connectionId, 'help', b) : undefined}
            defaultW={860}
            defaultH={620}
            minW={520}
            minH={360}
            className={className ? `help-modal ${className}` : 'help-modal'}
            bodyClassName="help-modal__body"
        >
            <aside className="help-sidebar">
                <div className="help-sidebar__search">
                    <input
                        type="text"
                        className="help-search"
                        placeholder="Search help…"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        autoFocus
                    />
                </div>
                <nav className="help-index">
                    {matches.length === 0 && (
                        <div className="help-index__empty">No topic mentions “{query}”</div>
                    )}
                    {matches.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            className={`help-index__item${t.id === topicId ? ' is-active' : ''}`}
                            onClick={() => setTopicId(t.id)}
                        >
                            <span className="help-index__title">{t.title}</span>
                            <span className="help-index__blurb">{t.blurb}</span>
                        </button>
                    ))}
                </nav>
                <div className="help-sidebar__foot">
                    {/* Everything about Mudlet itself — triggers, Lua, Geyser — is
                        documented once, upstream. Point at it rather than fork it. */}
                    <a href={MUDLET_WIKI} target="_blank" rel="noopener noreferrer">
                        Mudlet manual ↗
                    </a>
                </div>
            </aside>

            <div
                className="help-content"
                ref={contentRef}
                onClick={handleContentClick}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        </ResizableModal>
    );
}
