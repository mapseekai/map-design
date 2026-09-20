export class SourceDocumentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SourceDocumentError';
  }
}

export interface SourceDocument {
  readonly text: string;
  readonly document: unknown;
}

export function decodeSourceDocument(body: Uint8Array): SourceDocument {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw new SourceDocumentError('Source document is not valid UTF-8', { cause: error });
  }
  try {
    return { text, document: JSON.parse(text) as unknown };
  } catch (error) {
    throw new SourceDocumentError('Source document is not valid JSON', { cause: error });
  }
}
