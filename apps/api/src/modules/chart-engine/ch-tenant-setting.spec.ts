import { isRowPolicyEnabled, tenantQuerySettings, TENANT_SETTING } from './ch-tenant-setting';

describe('isRowPolicyEnabled', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' On '])('treats %p as enabled', (v) => {
    expect(isRowPolicyEnabled(v)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'no', 'off', 'nope'])('treats %p as disabled', (v) => {
    expect(isRowPolicyEnabled(v as string | undefined)).toBe(false);
  });
});

describe('tenantQuerySettings', () => {
  it('is a pure no-op when the flag is OFF (default) — query path unchanged', () => {
    expect(tenantQuerySettings('org-uuid', false)).toEqual({});
  });

  it('binds the verified org UUID to the row-policy setting when ON', () => {
    expect(tenantQuerySettings('org-uuid', true)).toEqual({ [TENANT_SETTING]: 'org-uuid' });
  });

  it('refuses to fabricate a scope from an empty tenant even when ON', () => {
    // A missing verified tenant must NOT silently send an empty setting that a
    // policy might match against blank rows — return no setting instead.
    expect(tenantQuerySettings('', true)).toEqual({});
  });
});
