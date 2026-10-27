import {mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {readYaml} from './contracts.ts';
import {DmnStore} from './store.ts';
import {DshRootRuntime} from './dsh-runtime.ts';
import {OperatorService} from './operator.ts';
import {startWeb} from './web.ts';
const root=process.cwd(),database=resolve(process.argv[2]??'.dmn/dmn.sqlite');
const port=Number(process.argv[3]??4310);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
mkdirSync(dirname(database),{recursive:true});
const store=new DmnStore(database);
try{
 const service=new OperatorService(store,readYaml(resolve(root,'config/nodes.deepseek.yaml')),new DshRootRuntime({root:store.runtimeRoot,workspace:root}));
 const app=await startWeb(service,port);
 process.stderr.write(`DMN local UI listening on 127.0.0.1:${app.port}; no inference on page load.\n`);
 let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();store.close();};
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void close());
}catch{store.close();process.stderr.write('DMN web initialization failed; check local paths and port.\n');process.exitCode=1;}
