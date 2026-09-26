import { describe, it, expect } from 'vitest';
import { originAllowlistWarning } from './startup-checks';

describe('originAllowlistWarning', () => {
  it('warns in production when ALLOWED_ORIGINS is unset', () => {
    expect(originAllowlistWarning({ NODE_ENV: 'production' })).toMatch(/ALLOWED_ORIGINS/);
  });

  it('warns in production when ALLOWED_ORIGINS is a wildcard', () => {
    expect(originAllowlistWarning({ NODE_ENV: 'production', ALLOWED_ORIGINS: '*' })).toMatch(/wildcard|any origin/i);
  });

  it('warns when a wildcard hides among explicit origins', () => {
    expect(originAllowlistWarning({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://a.test, *' })).toBeTruthy();
  });

  it('stays quiet in production when explicit origins are set', () => {
    expect(originAllowlistWarning({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://demo.worldwideview.dev' })).toBeNull();
  });

  it('stays quiet outside production', () => {
    expect(originAllowlistWarning({ NODE_ENV: 'development' })).toBeNull();
  });
});
