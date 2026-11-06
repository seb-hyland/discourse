import type { ReactNode } from "react";

// Feather icons (https://feathericons.com), drawn in the current text colour.

const Icon = ({ d, children }: { d: string; children?: ReactNode }) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
        <path d={d} />
    </svg>
);

export const CommentIcon = () => <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;
export const CheckIcon = () => <Icon d="M20 6 9 17l-5-5" />;
export const MoveIcon = () => <Icon d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM22 12h-4M6 12H2M12 6V2M12 22v-4" />;
export const ReplyIcon = () => <Icon d="M9 14 4 9l5-5M20 20v-7a4 4 0 0 0-4-4H4" />;
export const EditIcon = () => <Icon d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />;
export const DeleteIcon = () => <Icon d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />;
export const LinkIcon = () => (
    <Icon d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
);
export const ExternalIcon = () => <Icon d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />;
export const CloseIcon = () => <Icon d="M18 6 6 18M6 6l12 12" />;
export const BackIcon = () => <Icon d="M19 12H5M12 19l-7-7 7-7" />;
export const ForwardIcon = () => <Icon d="M5 12h14M12 5l7 7-7 7" />;
export const SettingsIcon = () => (
    <Icon d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z">
        <circle cx="12" cy="12" r="3" />
    </Icon>
);
export const ChevronIcon = () => <Icon d="m9 18 6-6-6-6" />;
export const SidebarIcon = () => <Icon d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18" />;

/** An icon button, with an instant tooltip (see Tooltip). `on` makes it a toggle. */
export function IconButton({
    tip,
    on,
    disabled,
    onClick,
    children,
}: {
    tip: string;
    on?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button className={on ? "icon on" : "icon"} data-tip={tip} aria-label={tip} aria-pressed={on} disabled={disabled} onClick={onClick}>
            {children}
        </button>
    );
}
