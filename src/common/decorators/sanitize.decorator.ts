import { Transform } from "class-transformer";
import * as DOMPurify from "isomorphic-dompurify";

export interface SanitizeOptions {
  allowedTags?: string[];
  allowedAttributes?: Record<string, string[]>;
}

export function Sanitize(options?: SanitizeOptions) {
  return Transform(({ value }) => {
    if (typeof value !== "string") {
      return value;
    }

    const sanitizeFn =
      (DOMPurify as any).sanitize || (DOMPurify as any).default?.sanitize;

    if (typeof sanitizeFn !== "function") {
      return value;
    }

    const config: any = {};
    if (options?.allowedTags) {
      config.ALLOWED_TAGS = options.allowedTags;
    }
    if (options?.allowedAttributes) {
      config.ALLOWED_ATTR = Object.keys(options.allowedAttributes);
    }

    return sanitizeFn(value, config);
  });
}
