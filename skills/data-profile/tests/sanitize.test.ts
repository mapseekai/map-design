import {describe, expect, it} from 'vitest';

import {sanitizeReference} from '../src/sanitize.js';

describe('sanitizeReference', () => {
  it('redacts authority credentials and opaque URL parts while preserving template braces', () => {
    expect(
      sanitizeReference(
        'https://user:password@tiles.example/{z}/{x}/{y}.pbf?token=top-secret#private',
      ),
    ).toEqual({
      value: 'https://tiles.example/{z}/{x}/{y}.pbf',
      credentialRedacted: true,
      validHttpUrl: true,
      explicitLocalTemplate: false,
    });
  });

  it('sanitizes provider URLs without claiming they are HTTP-inspectable', () => {
    expect(
      sanitizeReference('mapbox://user:password@tileset/{z}/{x}/{y}?token=secret'),
    ).toEqual({
      value: 'mapbox://tileset/{z}/{x}/{y}',
      credentialRedacted: true,
      validHttpUrl: false,
      explicitLocalTemplate: false,
    });
  });

  it('retains a safely redacted invalid HTTP declaration as reportable evidence', () => {
    expect(sanitizeReference('https://?unknown=not-retained')).toEqual({
      value: 'https://',
      credentialRedacted: true,
      validHttpUrl: false,
      explicitLocalTemplate: false,
    });
  });

  it('does not treat a queried local path as an explicit local template', () => {
    expect(sanitizeReference('./tiles/{z}/{x}/{y}.pbf?token=secret')).toEqual({
      value: './tiles/{z}/{x}/{y}.pbf',
      credentialRedacted: true,
      validHttpUrl: false,
      explicitLocalTemplate: false,
    });
  });
});
