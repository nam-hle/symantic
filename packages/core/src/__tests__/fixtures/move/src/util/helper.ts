import { base } from "../lib/base.js";
import type { Shape } from "./shape.js";

export const help = (shape: Shape): number => base + shape.size;
