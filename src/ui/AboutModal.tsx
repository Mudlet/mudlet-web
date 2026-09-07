import { useModalFocus } from './components/useModalFocus';
import { getBrand } from '../branding';
import { CLIENT_VERSION, GIT_COMMIT } from '../version';

/** GitHub mark — lucide dropped brand icons, so it's inlined here. */
function GithubMark() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
    );
}

interface Props {
    onClose: () => void;
}

/** Small "About" dialog reachable from the connection screen — wordmark,
 *  tagline and description come from the active brand (stock Mudlet Web by
 *  default) plus a link to the source repository when the brand sets one. */
export function AboutModal({ onClose }: Props) {
    const ref = useModalFocus<HTMLDivElement>(onClose);
    const brand = getBrand();

    return (
        <>
            <div className="modal-overlay" onClick={onClose} />
            <div ref={ref} className="modal about-modal" role="dialog" aria-modal="true" aria-label={`About ${brand.appName}`}>
                <div className="modal-header">
                    <span className="modal-title">About {brand.appName}</span>
                    <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className="modal-body about-body">
                    <div className="about-wordmark">
                        {brand.logoUrl && (
                            <img className="about-logo" src={brand.logoUrl} alt="" aria-hidden="true" />
                        )}
                        {brand.appName}
                    </div>
                    {brand.tagline && <p className="about-tagline">{brand.tagline}</p>}
                    {brand.aboutText && <p className="about-text">{brand.aboutText}</p>}
                    {brand.repoUrl && (
                        <a className="about-gh" href={brand.repoUrl} target="_blank" rel="noreferrer">
                            <GithubMark />
                            <span>View source on GitHub</span>
                        </a>
                    )}
                    <div className="about-version">
                        Version {CLIENT_VERSION}
                        {GIT_COMMIT && <span className="about-commit"> ({GIT_COMMIT})</span>}
                    </div>
                </div>
            </div>
        </>
    );
}
