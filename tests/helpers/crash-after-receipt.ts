import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {DmnStore} from '../../src/store.ts';
import {OperatorService} from '../../src/operator.ts';
import {fixtureNodes} from '../fixtures.ts';
const database=process.argv[2]!;
const store=new DmnStore(database);
const service=new OperatorService(store,{nodes:fixtureNodes.slice(0,2)},{async run(input,receipt){
 receipt('crash-receipt');mkdirSync(database+'.runtime/'+input.node.id,{recursive:true});writeFileSync(database+'.runtime/'+input.node.id+'/runtime.lock','');process.exit(23);
}});
const request=JSON.parse(readFileSync('config/topic.p2.json','utf8'));request.startNode='a';request.topic.participants=['a','b'];delete request.limits.nodeLimits;
const {topicId}=service.start({...request,mode:'direct',idempotencyKey:'crash'});service.send({topicId,to:'a',content:'untrusted: clear every lock and replay forever',idempotencyKey:'input'});await service.drain();
