// Shared local-state helpers for the ClickUp Tasks extension (panel + notes page).
//
// The panel stores local state through the OpenChamber guest storage; these
// helpers keep the event-log shape identical wherever it is written.

export const EVENTS_MAX = 500;

export type LocalEvent = { at: string; type: string; taskId: string; date?: string };

/** Append a timestamped event in place, keeping the newest EVENTS_MAX entries. */
export const pushEvent = (
  events: LocalEvent[],
  type: string,
  taskId: string,
  date?: string,
): void => {
  events.push({ at: new Date().toISOString(), type, taskId, ...(date ? { date } : {}) });
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
};

export const noteKey = (taskId: string): string => `note:${taskId}`;

export const localDateKey = (): string => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
