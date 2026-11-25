/** How an SP tag should look: Todoist colour plus a Material icon ("tag" = #, for projects; "label" for labels). */
export interface TagStyle {
  title: string;
  color: string;
  icon: string;
}

interface ExistingTag {
  id: string;
  title: string;
  color?: string | null;
  icon?: string | null;
}

/** The updates needed so existing tags match their Todoist style. Tags not (yet) created are skipped. */
export const tagUpdates = (existing: ExistingTag[], styles: TagStyle[]) => {
  const byTitle = new Map(styles.map((s) => [s.title, s] as const));
  return existing.flatMap((tag) => {
    const style = byTitle.get(tag.title);
    if (!style || (tag.color === style.color && tag.icon === style.icon)) return [];
    return [{ id: tag.id, updates: { color: style.color, icon: style.icon } }];
  });
};
