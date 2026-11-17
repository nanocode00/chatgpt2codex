import { useEffect } from "react";

/** Publish only the active screen's pending operations to the shared topbar.
 * Reset the report on unmount so a previous screen cannot leave it spinning. */
export function useScreenBusy(onBusyChange: ((waiting: boolean) => void) | undefined, waiting: boolean): void {
  useEffect(() => { onBusyChange?.(waiting); }, [onBusyChange, waiting]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
}
