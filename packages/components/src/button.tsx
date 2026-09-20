export { Button, buttonVariants } from "./ui/button";
import type { ComponentProps } from "react";
import type { Button } from "./ui/button";
export type ButtonProps = ComponentProps<typeof Button>;
export type ButtonVariant = ButtonProps["variant"];
export type ButtonSize = ButtonProps["size"];
