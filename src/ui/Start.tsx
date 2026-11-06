import { useEffect, useState } from "react";
import type { Recent } from "../shared/api.ts";
import { api } from "./api.ts";
import { CloseIcon, IconButton } from "./icons.tsx";

/** Shown when no folder is open: recent folders to reopen, beside a button to pick another. */
export function Start() {
    const [recents, setRecents] = useState<Recent[] | null>(null);
    useEffect(() => void api.recents().then(setRecents, () => setRecents([])), []);

    return (
        <div className="start">
            <section>
                <header>
                    <h1>Recents</h1>
                    {!!recents?.length && (
                        <button className="clear" onClick={() => void api.forget().then(setRecents)}>
                            Clear
                        </button>
                    )}
                </header>
                {recents?.length === 0 && <p className="empty">No recent folders</p>}
                <ul>
                    {recents?.map(({ root, name, location }) => (
                        <li key={root}>
                            <button className="recent" onClick={() => void api.open(root).finally(() => api.recents().then(setRecents))}>
                                <strong>{name}</strong>
                                <span>{location}</span>
                            </button>
                            <IconButton tip={`Remove ${name} from Recents`} onClick={() => void api.forget(root).then(setRecents)}>
                                <CloseIcon />
                            </IconButton>
                        </li>
                    ))}
                </ul>
            </section>
            <button className="choose" onClick={() => void api.choose()}>
                Open Folder…
            </button>
        </div>
    );
}
