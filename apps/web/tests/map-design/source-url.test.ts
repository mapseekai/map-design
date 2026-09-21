import { describe, expect, it } from 'vitest';
import { parseMapSourceUrl } from '../../src/map-design/map/source-url';

describe('syntax-only map source URL', () => {
  it.each(['https://maps.example.com/style.json?key=demo', 'http://maps.example.com/tiles.json',
    'https://maps.example.com/data.geojson', 'https://maps.example.com/tiles.pmtiles'])('accepts %s without fetching it', (url) => {
    expect(parseMapSourceUrl('  ' + url + '  ')).toBe(url);
  });
  it.each(['', 'not-a-url', '/style.json', 'file:///style.json', 'javascript:alert(1)',
    'data:application/json,{}', 'ftp://maps.example.com/style.json',
    'https://user:secret@maps.example.com/style.json', 'https://maps.example.com/style.json#fragment',
    'https://maps.example.com/' + 'a'.repeat(4096)])('rejects an invalid or unsupported URL: %s', (url) => {
    expect(parseMapSourceUrl(url)).toBeNull();
  });
});
