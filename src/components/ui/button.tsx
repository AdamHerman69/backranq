import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/[0.55] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-control motion-safe:hover:-translate-y-px motion-safe:hover:shadow-raised motion-safe:active:translate-y-0 motion-safe:active:scale-[0.985]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-control motion-safe:hover:-translate-y-px motion-safe:hover:bg-destructive/[0.92] motion-safe:hover:shadow-raised motion-safe:active:translate-y-0 motion-safe:active:scale-[0.985]",
        success:
          "bg-success text-success-foreground shadow-control motion-safe:hover:-translate-y-px motion-safe:hover:bg-success/[0.92] motion-safe:hover:shadow-raised motion-safe:active:translate-y-0 motion-safe:active:scale-[0.985]",
        outline:
          "border border-input bg-card/80 text-foreground shadow-control backdrop-blur-sm motion-safe:hover:-translate-y-px motion-safe:hover:border-primary/25 motion-safe:hover:bg-accent motion-safe:hover:text-accent-foreground motion-safe:hover:shadow-card motion-safe:active:translate-y-0 motion-safe:active:scale-[0.985]",
        secondary:
          "bg-secondary text-secondary-foreground motion-safe:hover:-translate-y-px motion-safe:hover:bg-secondary/[0.78] motion-safe:active:translate-y-0 motion-safe:active:scale-[0.985]",
        quiet:
          "bg-primary/[0.09] text-primary motion-safe:hover:bg-primary/[0.14] motion-safe:active:scale-[0.985]",
        ghost:
          "text-foreground motion-safe:hover:bg-accent motion-safe:hover:text-accent-foreground motion-safe:active:scale-[0.985]",
        board:
          "border border-white/15 bg-foreground/[0.88] text-background shadow-raised backdrop-blur-md motion-safe:hover:-translate-y-px motion-safe:hover:bg-foreground motion-safe:active:translate-y-0 motion-safe:active:scale-[0.985] dark:bg-background/[0.88] dark:text-foreground",
        link:
          "h-auto rounded-none p-0 text-primary underline-offset-4 hover:underline motion-safe:active:scale-[0.985]",
      },
      size: {
        default: "h-11 px-4 py-2 sm:h-10",
        sm: "h-11 rounded-md px-3 text-xs sm:h-9",
        lg: "h-12 rounded-lg px-7 text-base",
        icon: "h-11 w-11 p-0 sm:h-10 sm:w-10",
        "icon-sm": "h-11 w-11 p-0 sm:h-9 sm:w-9",
        "icon-lg": "h-12 w-12 rounded-lg p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
