// Radix-backed primitives live outside ui.tsx so @radix-ui stays out of the startup bundle.
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: { checked: boolean; onCheckedChange: (c: boolean) => void } & Omit<
  React.ComponentProps<typeof SwitchPrimitive.Root>,
  "checked" | "onCheckedChange"
>) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={props["aria-label"] ?? "Toggle"}
      className={cn(
        "group inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-transparent transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-11 items-center rounded-full bg-border-2 transition-colors group-data-[state=checked]:bg-primary-button"
      >
        <SwitchPrimitive.Thumb className="block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5" />
      </span>
    </SwitchPrimitive.Root>
  );
}
