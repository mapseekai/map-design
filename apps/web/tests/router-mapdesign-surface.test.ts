import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/router';

describe('MapDesign-only entry routes', () => {
  it.each([
    '/community',
    '/community/template-1',
    '/plugins',
    '/plugins/sample-plugin',
    '/marketplace',
    '/marketplace/sample-plugin',
  ])('falls back from retired route %s to MapDesign home', (pathname) => {
    expect(parseRoute(pathname)).toEqual({ kind: 'home' });
  });
});
