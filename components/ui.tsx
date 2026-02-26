import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md font-mono text-xs uppercase tracking-wide transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-orange-600 text-zinc-950 hover:bg-orange-500",
        outline: "border border-zinc-700 bg-transparent text-zinc-300 hover:border-orange-500/60 hover:text-zinc-100",
        secondary: "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-8 px-2.5 text-[10px]",
        lg: "h-10 px-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border bg-zinc-950/80 text-zinc-100 shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 p-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-orange-600 text-zinc-950",
        secondary: "bg-zinc-800 text-zinc-300",
        outline: "border border-zinc-700 text-zinc-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
