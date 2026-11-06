import { useEffect, useState } from "react";
import type { Recent } from "../shared/api.ts";
import { api } from "./api.ts";

/** Shown when no folder is open: recent folders to reopen, beside a button to pick another. */
export function Start() {
    const [recents, setRecents] = useState<Recent[] | null>(null);
    useEffect(() => void api.recents().then(setRecents), []);

    return (
        <div className="start">
            <section>
                <h1>Recents</h1>
                {recents?.length === 0 && <p className="empty">No recent projects</p>}
                <ul>
                    {recents?.map(({ root, name, location }) => (
                        <li key={root}>
                            <button onClick={() => api.open(root)}>
                                <strong>{name}</strong>
                                <span>{location}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </section>
            <button className="choose" onClick={() => api.choose()}>
                Open Folder…
            </button>
        </div>
    );
}
