export type TableSelection =
  | { mode: "ids"; ids: Set<string> }
  | { mode: "all"; excluded: Set<string> };

export type SelectionModifiers = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function isTableRowSelected(selection: TableSelection, id: string) {
  return selection.mode === "all"
    ? !selection.excluded.has(id)
    : selection.ids.has(id);
}

export function selectedTableCount(selection: TableSelection, total: number) {
  return selection.mode === "all"
    ? Math.max(0, total - selection.excluded.size)
    : selection.ids.size;
}

export function toggleTableRow(
  selection: TableSelection,
  pageIds: string[],
  index: number,
  anchor: number | null,
  modifiers: SelectionModifiers,
) {
  const id = pageIds[index];
  if (!id) return { selection, anchor };
  if (selection.mode === "all") {
    const excluded = new Set(selection.excluded);
    if (excluded.has(id)) excluded.delete(id);
    else excluded.add(id);
    return { selection: { mode: "all" as const, excluded }, anchor: index };
  }
  const ids = new Set(selection.ids);
  const additive = Boolean(modifiers.ctrlKey || modifiers.metaKey);
  if (modifiers.shiftKey && anchor !== null) {
    const [from, to] = [anchor, index].sort((a, b) => a - b);
    if (!additive) ids.clear();
    for (let cursor = from; cursor <= to; cursor += 1) {
      if (pageIds[cursor]) ids.add(pageIds[cursor]);
    }
  } else if (additive) {
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
  } else {
    ids.clear();
    ids.add(id);
  }
  return { selection: { mode: "ids" as const, ids }, anchor: index };
}

export function toggleTablePage(
  selection: TableSelection,
  pageIds: string[],
) {
  const every =
    pageIds.length > 0 &&
    pageIds.every((id) => isTableRowSelected(selection, id));
  if (selection.mode === "all") {
    const excluded = new Set(selection.excluded);
    for (const id of pageIds) {
      if (every) excluded.add(id);
      else excluded.delete(id);
    }
    return { mode: "all" as const, excluded };
  }
  const ids = new Set(selection.ids);
  for (const id of pageIds) {
    if (every) ids.delete(id);
    else ids.add(id);
  }
  return { mode: "ids" as const, ids };
}
