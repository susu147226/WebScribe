import type { TaskState } from "../types";

/** 状态到视觉分组的映射。 */
const VARIANT: Record<TaskState, string> = {
  Pending: "pending",
  Fetching: "active",
  Rendering: "active",
  Extracting: "active",
  Converting: "active",
  Saving: "active",
  Completed: "done",
  Skipped: "skipped",
  Failed: "failed",
  Blocked: "blocked",
  RequiresLogin: "blocked",
};

export function StatusBadge({ state, label }: { state: TaskState; label: string }) {
  return (
    <span className={`badge badge--${VARIANT[state]}`}>
      <span className="badge__dot" />
      {label}
    </span>
  );
}
