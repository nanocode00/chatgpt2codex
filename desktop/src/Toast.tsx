import { CircleAlert, CircleCheck } from "lucide-react";
import "./toast.css";

export interface AppToast {
  id: number;
  message: string;
  tone: "info" | "error";
}

/** Overlay feedback: never inserts layout-shifting copy/operation text into a card. */
export function Toast({ toast }: { toast: AppToast | null }) {
  return <div className="c2c-toast-region" aria-live="polite" aria-atomic="true">
    {toast && <div key={toast.id} className={"c2c-toast c2c-toast-" + toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.tone === "error" ? <CircleAlert size={16}/> : <CircleCheck size={16}/>}
      <span>{toast.message}</span>
    </div>}
  </div>;
}
