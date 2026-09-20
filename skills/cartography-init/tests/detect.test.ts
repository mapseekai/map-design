import { describe, expect, it } from 'vitest';
import { detectSource } from '../src/detect.js';
import { loadFixture } from './helpers.js';

describe('detectSource', () => {
  it('detects style.json by extension and content', () => {
    expect(detectSource('/tmp/a.json', loadFixture('style-min.json'))).toBe('style');
  });

  it('detects sld by xml root when extension is odd', () => {
    const buf = Buffer.from('<?xml version="1.0"?><StyledLayerDescriptor xmlns="http://www.opengis.net/sld" version="1.0.0"/>');
    expect(detectSource('/tmp/a.bin', buf)).toBe('sld');
  });
});
