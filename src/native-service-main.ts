import{z}from'zod';
import{mkdirSync}from'node:fs';import{resolve,dirname}from'node:path';
import{DshRootRuntime}from'./dsh-runtime.ts';import{readYaml}from'./contracts.ts';import{databasePath}from'./maintenance.ts';import{startNativeService}from'./native-service.ts';
const [databaseArg,rootArg]=process.argv.slice(2);if(!databaseArg||!rootArg)throw Error('Native service requires trusted launch paths.');
mkdirSync(dirname(resolve(databaseArg)),{recursive:true});const database=databasePath(databaseArg),root=resolve(rootArg);
try{const config=readYaml(resolve(root,'config/nodes.deepseek.yaml')) as {nodes:{id:string;model:string}[]};if(process.env.DMN_NODE_MODELS){const models=z.tuple([z.enum(['deepseek-flash','deepseek-v4-pro']),z.enum(['deepseek-flash','deepseek-v4-pro'])]).parse(JSON.parse(process.env.DMN_NODE_MODELS));config.nodes.forEach((n,i)=>{n.model=models[i]!;});}const app=await startNativeService(database,config,new DshRootRuntime({root:database+'.runtime',workspace:root}),{canInfer:!!process.env.DEEPSEEK_API_KEY});
 process.send?.({ready:true,descriptor:app.descriptor,ownerToken:app.ownerToken});
 const stop=()=>void app.stop().then(()=>{if(process.connected)process.disconnect();}).catch(()=>{process.exitCode=1;});for(const signal of ['SIGINT','SIGTERM','disconnect']as const)process.on(signal,stop);
}catch{process.send?.({ready:false,error:'INSTANCE_UNAVAILABLE'});process.exitCode=1;if(process.connected)process.disconnect();}
