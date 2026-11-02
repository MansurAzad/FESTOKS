import { cn } from "@/lib/utils";

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "accent" }) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-card p-3 sm:p-4", tone === "accent" && "border-accent bg-accent/15")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 break-words font-display text-lg font-bold sm:text-2xl", tone === "good" && "text-success", tone === "bad" && "text-destructive")}>{value}</div>
    </div>
  );
}

export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-4 min-w-0 break-words font-display text-xl font-bold sm:text-2xl">{children}</h1>;
}
