// node --test lib/circle/members.test.ts  (o: npx tsx lib/circle/members.test.ts)
import assert from 'node:assert';
import { pickMember } from './members';

const m = { id: 87177987, email: 'cruzc51@gmail.com', name: 'Angello Blubear' };

// La forma que Circle v2 devuelve de verdad — la que el codigo ignoraba.
assert.deepEqual(pickMember(m), m);
assert.deepEqual(pickMember([m]), m);
assert.deepEqual(pickMember({ community_members: [m] }), m);

assert.equal(pickMember(null), null);
assert.equal(pickMember([]), null);
assert.equal(pickMember({ community_members: [] }), null);

console.log('pickMember OK');
