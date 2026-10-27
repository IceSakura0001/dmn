import { DmnStore } from '../../src/store.ts';
import { DmnGateway } from '../../src/gateway.ts';

const store = new DmnStore(process.argv[2]!);
const gateway = new DmnGateway(store, () => new Date('2026-10-26T00:00:01Z'));
gateway.bindNode('a').send({ to: 'b', topicId: process.argv[3]!, content: 'durable before abrupt exit', idempotencyKey: 'abrupt-exit' });
// Deliberately skip close()/finally, simulating process loss after COMMIT.
process.exit(23);
