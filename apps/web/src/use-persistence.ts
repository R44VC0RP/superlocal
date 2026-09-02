import { useEffect, useEffectEvent } from "react";
import { writeSaved } from "./storage.ts";

export function usePersistence(
  key: string,
  value: unknown,
  onFailure: () => void,
) {
  const fail = useEffectEvent(onFailure);
  useEffect(() => {
    if (!writeSaved(key, value)) fail();
  }, [key, value]);
}
