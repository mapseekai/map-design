import { describe, expect, it } from 'vitest';

import { sanitizeMapAgentLaunchEnvironment } from '../../../src/map-design/agents/launch-environment.js';

describe('Agent network environment', () => {
  it('preserves proxy routing, bypasses and custom CA configuration across repeated sanitization', () => {
    const network = {
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      ALL_PROXY: 'socks5://127.0.0.1:7898',
      NO_PROXY: 'localhost,127.0.0.1',
      http_proxy: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897',
      all_proxy: 'socks5://127.0.0.1:7898',
      no_proxy: 'localhost,127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/certs/local-ca.pem',
    };
    const environment = sanitizeMapAgentLaunchEnvironment({
      ...network,
      MAP_DESIGN_API_TOKEN: 'private-token',
      DATABASE_URL: 'private-database',
      NODE_OPTIONS: '--require=/untrusted.js',
    });
    expect(environment).toEqual(network);
    expect(sanitizeMapAgentLaunchEnvironment(environment)).toEqual(network);
  });
});
