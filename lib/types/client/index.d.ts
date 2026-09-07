import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services: picker pipeline, session projection, Remote face, slots, and locale. */
export declare const inject: string[];
/**
 * Compose the @file surface.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
