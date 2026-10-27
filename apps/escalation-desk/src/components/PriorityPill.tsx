import type { Priority } from "@/lib/api";

export function PriorityPill({ priority }: { priority: Priority }) {
  const label = priority === "high" ? "High priority" : priority === "low" ? "Low priority" : "Normal priority";
  return <span className={`pill pill-${priority}`}>{label}</span>;
}

export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
