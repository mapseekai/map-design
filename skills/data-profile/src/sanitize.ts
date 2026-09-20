export interface SanitizedReference {
  value: string;
  credentialRedacted: boolean;
  validHttpUrl: boolean;
  explicitLocalTemplate: boolean;
}

function explicitLocalTemplate(value: string): boolean {
  return !/[?#]/.test(value) && /^(?:\.(?:\.|\/)|\/(?!\/)|file:\/\/)/.test(value);
}

function removeOpaqueUrlParts(value: string): {value: string; credentialRedacted: boolean} {
  const hashIndex = value.indexOf('#');
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf('?');
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const authorityMatch = base.match(/^((?:[a-z][a-z\d+.-]*:)?\/\/)([^/?#]*)/i);
  const authorityPrefix = authorityMatch?.[1];
  const authority = authorityMatch?.[2];
  const matchedAuthority = authorityMatch?.[0];
  const sanitizedBase =
    authorityPrefix && authority && matchedAuthority && authority.includes('@')
      ? `${authorityPrefix}${authority.slice(authority.lastIndexOf('@') + 1)}${base.slice(
          matchedAuthority.length,
        )}`
      : base;

  return {
    value: sanitizedBase,
    credentialRedacted: hashIndex >= 0 || queryIndex >= 0 || sanitizedBase !== base,
  };
}

function preserveTemplateBraces(value: string): string {
  return value.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

/** Returns the only credential-safe representation retained by profile discovery and sampling. */
export function sanitizeReference(value: string): SanitizedReference {
  const explicitLocal = explicitLocalTemplate(value);
  if (!explicitLocal && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const credentialRedacted =
        url.username !== '' || url.password !== '' || value.includes('?') || value.includes('#');
      const validHttpUrl = url.protocol === 'http:' || url.protocol === 'https:';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return {
        value: preserveTemplateBraces(url.toString()),
        credentialRedacted,
        validHttpUrl,
        explicitLocalTemplate: false,
      };
    } catch {
      // Keep the safely redacted opaque form so invalid declarations remain reportable.
    }
  }

  const redacted = removeOpaqueUrlParts(value);
  return {
    ...redacted,
    validHttpUrl: false,
    explicitLocalTemplate: explicitLocal,
  };
}
