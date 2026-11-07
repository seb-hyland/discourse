import type { Conflict, ConflictVersion } from "../shared/api.ts";

/** A way to settle a conflict: keep a side's version (by index), keep both, or fix an invalid side by hand. */
export interface Choice {
    label: string;
    choice: number | "both" | "edit";
    tip?: string;
}

const valid = (v: Conflict["versions"][number]): v is ConflictVersion => typeof v === "object" && v !== null;

/**
 * What a conflict card says and offers: its heading; the choices, in order; and, where both sides
 * kept the comment with different text, the two versions to show what differs between.
 */
export function conflictChoices({ versions, sides, replies, thread }: Conflict): {
    heading: string;
    choices: Choice[];
    both: [ConflictVersion, ConflictVersion] | null;
} {
    const what = thread ? "reply" : "comment";
    const [first, second] = versions;
    const both = valid(first) && valid(second) && first.text !== second.text ? ([first, second] as [ConflictVersion, ConflictVersion]) : null;
    const withReplies = replies ? `, with ${replies === 1 ? "its reply" : `its ${replies} replies`}` : "";
    const choices: Choice[] = versions.flatMap((version, i): Choice[] =>
        version === "unreadable" ? [] : [{ label: version ? `Keep ${sides[i].label}` : `Keep it deleted (${sides[i].label})${withReplies}`, choice: i }],
    );
    if (both) choices.push({ label: "Keep both", choice: "both", tip: `Keeps ${sides[0].label}, with ${sides[1].label} as a reply` });
    if (versions.includes("unreadable")) choices.push({ label: "Open in editor", choice: "edit" });
    return {
        heading: versions.includes("unreadable")
            ? `One side's version of this ${what} isn't a valid comment.`
            : versions.includes(null)
              ? `One side deleted this ${what} and the other changed it.`
              : `Both sides changed this ${what}.`,
        choices,
        both,
    };
}
