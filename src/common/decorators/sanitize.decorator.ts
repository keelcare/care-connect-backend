import { Transform } from 'class-transformer';
import DOMPurify from 'isomorphic-dompurify';

export interface SanitizeOptions {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
}

export function Sanitize(options?: SanitizeOptions) {
    return Transform(({ value }) => {
        if (typeof value !== 'string') {
            return value;
        }

        return DOMPurify.sanitize(value, {
            ALLOWED_TAGS: options?.allowedTags,
            ALLOWED_ATTR: options?.allowedAttributes ? Object.keys(options.allowedAttributes) : undefined,
        });
    });
}
