/** Read-only screen refresh invoked by the shared top bar. The Promise
 * resolves after that screen's actual CLI read(s) have settled. */
export interface ScreenRefreshHandle {
  refresh(): Promise<void>;
}
