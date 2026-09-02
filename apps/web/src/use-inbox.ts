import { useEffect, useState, useSyncExternalStore } from "react";
import { InboxStore } from "./inbox";

export function useInbox() {
  const [store] = useState(() => new InboxStore());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => store.start(), [store]);
  return { ...state, store };
}
