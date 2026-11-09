export function createHistory() {
  return { past: [], future: [] };
}

export function pushHistory(history, action) {
  history.past.push(action);
  history.future.length = 0;
}

export function undoHistory(history) {
  const action = history.past.pop();
  if (!action) return null;
  history.future.push(action);
  return action;
}

export function redoHistory(history) {
  const action = history.future.pop();
  if (!action) return null;
  history.past.push(action);
  return action;
}
