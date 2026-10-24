export const container = (id = 'shipping', extra = {}) => ({ kind: 'focus', id, parentId: null,
  name: 'Shipping', createdAt: '2026-10-23', updatedAt: '2026-10-23', revision: 2,
  goals: 'Ship small changes', scope: 'Agents', constraints: 'Keep it small',
  planningDocs: ['docs/plan.md'], refs: ['https://example.invalid/spec'], notes: [], ...extra });
export const entry = (active = { focus: container(), subfocus: null }) => ({ id: 'binding-1',
  type: 'custom', customType: 'pi-focus:binding', data: { version: 1, active } });
