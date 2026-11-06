import { useEffect, useReducer, useState } from "react";
import type { FileSummary } from "../shared/api.ts";
import { BackIcon, ChevronIcon, CommentIcon, ForwardIcon, IconButton, SettingsIcon, SidebarIcon } from "./icons.tsx";

interface Folder {
    name: string;
    folders: Map<string, Folder>;
    files: FileSummary[];
    openThreads: number;
}

export function FileTree({
    files,
    current,
    onOpen,
    onSettings,
}: {
    files: FileSummary[];
    current: string;
    onOpen: (path: string) => void;
    onSettings: () => void;
}) {
    const [filter, setFilter] = useState("");
    const [commentedOnly, setCommentedOnly] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const { canGoBack, canGoForward } = useHistory();
    const shown = files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()) && (!commentedOnly || f.openThreads + f.resolvedThreads > 0));

    return (
        <nav className={collapsed ? "files collapsed" : "files"}>
            {!collapsed && (
                <div className="tree">
                    <FolderContents folder={buildTree(shown)} current={current} onOpen={onOpen} />
                </div>
            )}
            {!collapsed && (
                <div className="navigation">
                    <IconButton tip="Back" disabled={!canGoBack} onClick={() => history.back()}>
                        <BackIcon />
                    </IconButton>
                    <IconButton tip="Forward" disabled={!canGoForward} onClick={() => history.forward()}>
                        <ForwardIcon />
                    </IconButton>
                    <span className="spacer" />
                    <IconButton tip="Settings" onClick={onSettings}>
                        <SettingsIcon />
                    </IconButton>
                </div>
            )}
            <footer>
                <IconButton tip={collapsed ? "Show files" : "Hide files"} onClick={() => setCollapsed(!collapsed)}>
                    <SidebarIcon />
                </IconButton>
                {!collapsed && (
                    <>
                        <input placeholder="Find a file…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                        <IconButton tip="Only show commented files" on={commentedOnly} onClick={() => setCommentedOnly(!commentedOnly)}>
                            <CommentIcon />
                        </IconButton>
                    </>
                )}
            </footer>
        </nav>
    );
}

/** Whether the window can go back or forward through the files and comments opened. */
function useHistory() {
    const [, update] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        navigation.addEventListener("currententrychange", update);
        return () => navigation.removeEventListener("currententrychange", update);
    }, []);
    return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward };
}

function FolderContents({ folder, current, onOpen }: { folder: Folder; current: string; onOpen: (path: string) => void }) {
    return (
        <ul>
            {[...folder.folders.values()].map((sub) => (
                <li key={sub.name}>
                    <details open>
                        <summary>
                            <ChevronIcon />
                            <span className="name">{sub.name}</span>
                            {sub.openThreads > 0 && <span className="count">{sub.openThreads}</span>}
                        </summary>
                        <FolderContents folder={sub} current={current} onOpen={onOpen} />
                    </details>
                </li>
            ))}
            {folder.files.map((f) => (
                <li key={f.path}>
                    <button className={f.path === current ? "current" : undefined} onClick={() => onOpen(f.path)}>
                        <span className={f.missing ? "name missing" : "name"} data-tip={f.missing ? "Deleted, but its comments remain" : undefined}>
                            {f.path.slice(f.path.lastIndexOf("/") + 1)}
                        </span>
                        {f.attention ? (
                            <span className="count broken" data-tip="Some of its comments need your attention">
                                !
                            </span>
                        ) : (
                            f.openThreads > 0 && <span className="count">{f.openThreads}</span>
                        )}
                    </button>
                </li>
            ))}
        </ul>
    );
}

function buildTree(files: FileSummary[]): Folder {
    const root = folder("");
    for (const file of files) {
        let at = root;
        at.openThreads += file.openThreads;
        for (const name of file.path.split("/").slice(0, -1)) {
            if (!at.folders.has(name)) at.folders.set(name, folder(name));
            at = at.folders.get(name)!;
            at.openThreads += file.openThreads;
        }
        at.files.push(file);
    }
    return compact(root);
}

/** Merges folders that only contain one folder, as in `sources/thelang-naive`. */
function compact(f: Folder): Folder {
    for (const [key, sub] of f.folders) f.folders.set(key, compact(sub));
    const [only] = f.folders.values();
    if (f.name && f.files.length === 0 && f.folders.size === 1) return { ...only, name: `${f.name}/${only.name}` };
    return f;
}

function folder(name: string): Folder {
    return { name, folders: new Map(), files: [], openThreads: 0 };
}
